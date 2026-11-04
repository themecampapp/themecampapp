// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm";
import { burn, dues, INTENTS, participation, person, ticketRequest } from "~/db/schema";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { onRsvpChanged } from "./sap-cascade.server";

export type Intent = (typeof INTENTS)[number];

export type RsvpInput = {
  intent: Intent | null;
  arrivalDate: string | null;
  departureDate: string | null;
  sapRequested: boolean | null;
  sapDate: string | null;
  dwellingDescription: string | null;
  dwellingSize: string | null;
  generator: boolean | null;
};

const FIELDS = [
  "intent",
  "arrivalDate",
  "departureDate",
  "sapRequested",
  "sapDate",
  "dwellingDescription",
  "dwellingSize",
  "generator",
] as const;

// The current season is stored in the database (camp_settings.current_year, read through the
// SQL function current_year()), so an Admin can roll over to a new year without a code change.
// SQL queries use current_year() directly; this is for labels and the season row.
export async function currentYear(db: Db): Promise<number> {
  const [row] = await db.execute<{ year: number }>(sql`select current_year() as year`);
  if (!row?.year) throw new Error("current_year() returned nothing: is any season set up?");
  return Number(row.year);
}

export async function currentSeason(db: Db) {
  const [season] = await db.select().from(burn).where(sql`${burn.year} = current_year()`);
  if (!season) throw new Error("the current season's burn row is missing");
  return season;
}

// One person's current-season RSVP, plus who last changed it (for "Updated by … on …").
export async function getRsvp(db: Db, personId: string) {
  const season = await currentSeason(db);
  const rows = await db.execute<{
    intent: Intent | null;
    arrival_date: string | null;
    departure_date: string | null;
    sap_requested: boolean | null;
    sap_date: string | null;
    dwelling_description: string | null;
    dwelling_size: string | null;
    generator: boolean | null;
    updated_at: Date;
    updated_by_person_id: string | null;
    updated_by_name: string | null;
  }>(sql`
    select pa.*, coalesce(u.playa_name, u.legal_name) as updated_by_name
    from participation pa
    left join person u on u.id = pa.updated_by_person_id
    where pa.person_id = ${personId} and pa.burn_id = ${season.id}
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    intent: r.intent,
    arrivalDate: r.arrival_date,
    departureDate: r.departure_date,
    sapRequested: r.sap_requested,
    sapDate: r.sap_date,
    dwellingDescription: r.dwelling_description,
    dwellingSize: r.dwelling_size,
    generator: r.generator,
    updatedAt: new Date(r.updated_at).toISOString(),
    updatedByOther:
      r.updated_by_person_id && r.updated_by_person_id !== personId ? r.updated_by_name : null,
  };
}

// Parses the RSVP form. Blank means "unknown" (null), never "no".
export function parseRsvpForm(form: FormData): { input: RsvpInput } | { error: string } {
  const text = (k: string, max = 200) => {
    const v = String(form.get(k) ?? "").trim();
    return v ? v.slice(0, max) : null;
  };
  const tri = (k: string) => {
    const v = form.get(k);
    return v === "yes" ? true : v === "no" ? false : null;
  };
  const date = (k: string) => {
    const v = text(k, 10);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const rawIntent = text("intent");
  const intent =
    rawIntent && (INTENTS as readonly string[]).includes(rawIntent) ? (rawIntent as Intent) : null;
  if (rawIntent && !intent) return { error: "Pick one of the RSVP options." };
  const input: RsvpInput = {
    intent,
    arrivalDate: date("arrivalDate"),
    departureDate: date("departureDate"),
    sapRequested: tri("sapRequested"),
    // The SAP day only means something alongside a request.
    sapDate: tri("sapRequested") === true ? date("sapDate") : null,
    dwellingDescription: text("dwellingDescription", 500),
    dwellingSize: text("dwellingSize"),
    generator: tri("generator"),
  };
  if (input.arrivalDate && input.departureDate && input.departureDate < input.arrivalDate) {
    return { error: "Departure can't be before arrival." };
  }
  return { input };
}

// Saves an RSVP (by the member, or a Lead on their behalf). Last write wins; every change is
// audited with the actor. Switching to Not going withdraws the ticket request and flags paid
// dues for the Treasurer; switching back reactivates the request.
export async function saveRsvp(db: Db, actorPersonId: string, personId: string, input: RsvpInput) {
  const season = await currentSeason(db);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(participation)
      .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)))
      .for("update");
    // Only this season's SAP days can be requested (the form offers nothing else).
    const sapDate =
      input.sapDate && (season.sapDays ?? []).includes(input.sapDate) ? input.sapDate : null;
    const values = { ...input, sapDate, updatedByPersonId: actorPersonId, updatedAt: new Date() };
    const [after] = before
      ? await tx
          .update(participation)
          .set(values)
          .where(eq(participation.id, before.id))
          .returning()
      : await tx
          .insert(participation)
          .values({ personId, burnId: season.id, ...values })
          .returning();

    const wasOut = before?.intent === "not_going";
    const isOut = after.intent === "not_going";
    if (isOut !== wasOut) {
      await tx
        .update(ticketRequest)
        .set({ active: !isOut, updatedAt: new Date() })
        .where(eq(ticketRequest.participationId, after.id));
      if (isOut) {
        await tx
          .update(dues)
          .set({ flagged: true, updatedAt: new Date() })
          .where(and(eq(dues.participationId, after.id), eq(dues.status, "paid")));
      }
    }

    // A SAP decision no longer matches their plans: release the pass and flag it for Leads.
    await onRsvpChanged(tx, actorPersonId, personId, after.id, before ?? null, after);

    const pick = (row: Record<string, unknown> | undefined) =>
      row ? Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? null])) : null;
    await audit(tx, {
      actorPersonId,
      action: "rsvp_updated",
      subjectType: "person",
      subjectId: personId,
      before: pick(before),
      after: pick(after),
    });
  });
}

export async function personName(db: Db, personId: string) {
  const [p] = await db
    .select({ legalName: person.legalName, playaName: person.playaName })
    .from(person)
    .where(eq(person.id, personId));
  return p ? (p.playaName ?? p.legalName) : null;
}
