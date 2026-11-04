// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, dues, duesTier, participation } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { DUES_STATUSES, type DuesStatus } from "../dues";
import { getCampSettings } from "./camp-settings.server";
import { currentSeason } from "./participation.server";

export { formatCents } from "../dues";

// Camp dues for the current season. The Treasurer sets the amount and payment instructions
// and records each camper's status; Leads can look but not change anything; members see only
// their own. A camper who is Going or Leaning yes with no dues row counts as Unpaid.
// Issue #63: the Treasurer can add named tiers with their own amounts (need-based, for certain
// Leads...) and put campers on them; everyone else owes the standard amount. Which tier a
// camper is on is as private as what they've paid: the Treasurer and the camper only.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAX_CENTS = 100_000_00;
const refuse = (reason: string, status = 400) => data({ reason }, { status });

function assertTreasurer(actor: Viewer) {
  assertAccess(actor, "dues");
}

// "150", "$150", "150.5", "1,250.00" -> cents. Blank -> null. Anything else -> refused.
export function parseDollars(value: string): number | null {
  const s = value.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!s) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) throw refuse("bad_amount");
  const cents = Math.round(Number(s) * 100);
  if (cents > MAX_CENTS) throw refuse("bad_amount");
  return cents;
}

export type DuesTier = { id: string; name: string; amountCents: number };

const seasonTiers = (db: Db, burnId: string): Promise<DuesTier[]> =>
  db
    .select({ id: duesTier.id, name: duesTier.name, amountCents: duesTier.amountCents })
    .from(duesTier)
    .where(eq(duesTier.burnId, burnId))
    .orderBy(desc(duesTier.amountCents), asc(duesTier.name));

export async function getDuesSettings(db: Db) {
  const season = await currentSeason(db);
  return {
    year: season.year,
    amountCents: season.duesAmountCents,
    instructions: season.paymentInstructions,
    tiers: await seasonTiers(db, season.id),
  };
}

function tierInput(input: { name: string; amount: string }) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) throw refuse("dues_tier_name_needed");
  const amountCents = parseDollars(input.amount);
  if (amountCents === null) throw refuse("dues_tier_amount_needed");
  return { name, amountCents };
}

// Add a tier to this season, or change one (id given).
export async function saveDuesTier(
  db: Db,
  actor: Viewer,
  input: { id?: string; name: string; amount: string },
) {
  assertTreasurer(actor);
  const tier = tierInput(input);
  const season = await currentSeason(db);
  // Looked up in this season's list, so an id from another season (or not an id) is refused.
  const tiers = await seasonTiers(db, season.id);
  const before = input.id === undefined ? undefined : tiers.find((t) => t.id === input.id);
  if (input.id !== undefined && !before) throw refuse("dues_tier_unknown", 404);
  const taken = tiers.find((t) => t.name.toLowerCase() === tier.name.toLowerCase());
  if (taken && taken.id !== before?.id) throw refuse("dues_tier_name_taken", 409);
  await db.transaction(async (tx) => {
    if (before) {
      await tx.update(duesTier).set(tier).where(eq(duesTier.id, before.id));
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "dues_tier_updated",
        subjectType: "burn",
        subjectId: season.id,
        before: { name: before.name, amountCents: before.amountCents },
        after: tier,
      });
    } else {
      await tx.insert(duesTier).values({ burnId: season.id, ...tier });
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "dues_tier_added",
        subjectType: "burn",
        subjectId: season.id,
        before: null,
        after: tier,
      });
    }
  });
}

// Remove a tier: anyone on it goes back to the standard amount. What they've paid stays.
export async function removeDuesTier(db: Db, actor: Viewer, id: string) {
  assertTreasurer(actor);
  const season = await currentSeason(db);
  const before = (await seasonTiers(db, season.id)).find((t) => t.id === id);
  if (!before) throw refuse("dues_tier_unknown", 404);
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(dues)
      .set({ tierId: null, updatedAt: new Date() })
      .where(eq(dues.tierId, id))
      .returning({ id: dues.id });
    await tx.delete(duesTier).where(eq(duesTier.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "dues_tier_removed",
      subjectType: "burn",
      subjectId: season.id,
      before: { name: before.name, amountCents: before.amountCents },
      after: { movedToStandard: moved.length },
    });
    return { name: before.name, moved: moved.length };
  });
}

// A new season starts with the previous one's tiers (names and amounts), for the Treasurer to
// adjust. Nothing is copied into a season that already has tiers.
export async function copyDuesTiers(tx: Tx, fromBurnId: string, toBurnId: string) {
  await tx.execute(sql`
    insert into dues_tier (burn_id, name, amount_cents)
    select ${toBurnId}, name, amount_cents from dues_tier
    where burn_id = ${fromBurnId}
      and not exists (select 1 from dues_tier where burn_id = ${toBurnId})`);
}

export async function setDuesSettings(
  db: Db,
  actor: Viewer,
  input: { amount: string; instructions: string },
) {
  assertTreasurer(actor);
  const amountCents = parseDollars(input.amount);
  const instructions = input.instructions.trim().slice(0, 1000) || null;
  const season = await currentSeason(db);
  await db.transaction(async (tx) => {
    await tx
      .update(burn)
      .set({ duesAmountCents: amountCents, paymentInstructions: instructions })
      .where(eq(burn.id, season.id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "dues_settings_updated",
      subjectType: "burn",
      subjectId: season.id,
      before: { amountCents: season.duesAmountCents, instructions: season.paymentInstructions },
      after: { amountCents, instructions },
    });
  });
}

export type DuesRow = {
  personId: string;
  name: string;
  legalName: string;
  intent: string | null;
  status: DuesStatus;
  tierId: string | null; // null: the standard amount
  tierName: string | null;
  owedCents: number | null; // the tier's amount, else the standard amount (null if not set)
  amountCents: number | null;
  paidOn: string | null;
  method: string | null;
  flagged: boolean;
  recordedBy: string | null; // who last saved this camper's dues
};

// Everyone who owes dues this season (active, Going or Leaning yes), plus anyone with a dues
// record who has since changed their plans (so a paid-then-not-going camper stays visible).
export async function duesBoard(db: Db): Promise<DuesRow[]> {
  const season = await currentSeason(db);
  const rows = await db.execute<{
    person_id: string;
    legal_name: string;
    playa_name: string | null;
    intent: string | null;
    status: DuesStatus | null;
    tier_id: string | null;
    tier_name: string | null;
    tier_cents: number | null;
    amount_cents: number | null;
    paid_on: string | null;
    method: string | null;
    flagged: boolean | null;
    recorded_by: string | null;
  }>(sql`
    select p.id as person_id, p.legal_name, p.playa_name, pa.intent,
      d.status, d.tier_id, t.name as tier_name, t.amount_cents as tier_cents,
      d.amount_cents, d.paid_on, d.method, d.flagged,
      coalesce(rb.playa_name, rb.legal_name) as recorded_by
    from participation pa
    join person p on p.id = pa.person_id
    left join dues d on d.participation_id = pa.id
    left join dues_tier t on t.id = d.tier_id
    left join person rb on rb.id = d.updated_by_person_id
    where pa.burn_id = ${season.id} and p.active
      and (pa.intent in ('going', 'leaning_yes') or d.id is not null)
    order by lower(coalesce(p.playa_name, p.legal_name))
  `);
  return rows.map((r) => ({
    personId: r.person_id,
    name: r.playa_name ?? r.legal_name,
    legalName: r.legal_name,
    intent: r.intent,
    status: r.status ?? "unpaid",
    tierId: r.tier_id,
    tierName: r.tier_name,
    owedCents:
      r.tier_cents !== null
        ? Number(r.tier_cents)
        : season.duesAmountCents === null
          ? null
          : Number(season.duesAmountCents),
    amountCents: r.amount_cents === null ? null : Number(r.amount_cents),
    paidOn: r.paid_on,
    method: r.method,
    flagged: r.flagged ?? false,
    recordedBy: r.recorded_by,
  }));
}

const coming = (intent: string | null) => intent === "going" || intent === "leaning_yes";

// Unpaid = coming this year and not Paid or Waived.
export const isUnpaid = (r: Pick<DuesRow, "intent" | "status">) =>
  coming(r.intent) && r.status === "unpaid";

export function summarizeDues(rows: DuesRow[]) {
  return {
    unpaid: rows.filter(isUnpaid).length,
    paid: rows.filter((r) => r.status === "paid").length,
    waived: rows.filter((r) => r.status === "waived").length,
    flagged: rows.filter((r) => r.flagged).length,
    collectedCents: rows
      .filter((r) => r.status === "paid")
      .reduce((sum, r) => sum + (r.amountCents ?? 0), 0),
  };
}

export type DuesInput = {
  status: string;
  tier?: string; // a tier's id, or "" for the standard amount; absent leaves it as it is
  amount: string;
  paidOn: string;
  method: string;
};

// The Treasurer records one camper's dues and tier. Paid needs a date and method (the amount
// defaults to what they owe on their tier); Unpaid and Waived clear the payment details.
// Saving also clears the "plans changed" flag, since the Treasurer has now looked at it.
export async function recordDues(db: Db, actor: Viewer, personId: string, input: DuesInput) {
  assertTreasurer(actor);
  if (!DUES_STATUSES.includes(input.status as DuesStatus)) throw refuse("bad_status");
  const status = input.status as DuesStatus;
  const season = await currentSeason(db);
  const tiers = await seasonTiers(db, season.id);
  const tierChoice = input.tier === undefined ? undefined : input.tier || null;
  if (tierChoice && !tiers.some((t) => t.id === tierChoice)) throw refuse("dues_tier_unknown");

  let values: { amountCents: number | null; paidOn: string | null; method: string | null } = {
    amountCents: null,
    paidOn: null,
    method: null,
  };
  if (status === "paid") {
    // Checked again below against the camper's saved tier when no tier is sent.
    const amountCents = parseDollars(input.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) || Number.isNaN(Date.parse(input.paidOn))) {
      throw refuse("dues_date_needed");
    }
    const { paymentMethods } = await getCampSettings(db);
    if (!paymentMethods.includes(input.method)) throw refuse("dues_method_needed");
    values = { amountCents, paidOn: input.paidOn, method: input.method };
  }

  await db.transaction(async (tx) => {
    const [pa] = await tx
      .select({ id: participation.id, intent: participation.intent })
      .from(participation)
      .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)));
    const [before] = pa
      ? await tx.select().from(dues).where(eq(dues.participationId, pa.id)).for("update")
      : [];
    // Only campers on the dues list can be recorded: coming this year, or already recorded.
    if (!pa || (!coming(pa.intent) && !before)) throw refuse("dues_not_coming", 409);

    const tierId = tierChoice === undefined ? (before?.tierId ?? null) : tierChoice;
    if (status === "paid" && values.amountCents === null) {
      values.amountCents =
        tiers.find((t) => t.id === tierId)?.amountCents ?? season.duesAmountCents;
      if (values.amountCents === null) throw refuse("dues_amount_needed");
    }
    const next = { status, tierId, ...values, flagged: false, updatedByPersonId: actor.personId };
    await tx
      .insert(dues)
      .values({ participationId: pa.id, ...next })
      .onConflictDoUpdate({
        target: dues.participationId,
        set: { ...next, updatedAt: new Date() },
      });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "dues_updated",
      subjectType: "person",
      subjectId: personId,
      before: before
        ? {
            status: before.status,
            tierId: before.tierId,
            amountCents: before.amountCents,
            paidOn: before.paidOn,
            method: before.method,
          }
        : null,
      after: { status, tierId, ...values },
    });
  });
}

// A member's own dues card. Null when they aren't coming and have no dues record.
export async function myDues(db: Db, personId: string) {
  const season = await currentSeason(db);
  const [row] = await db
    .select({
      intent: participation.intent,
      status: dues.status,
      amountCents: dues.amountCents,
      paidOn: dues.paidOn,
      tierName: duesTier.name,
      tierCents: duesTier.amountCents,
    })
    .from(participation)
    .leftJoin(dues, eq(dues.participationId, participation.id))
    .leftJoin(duesTier, eq(duesTier.id, dues.tierId))
    .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)));
  if (!row || (!coming(row.intent) && !row.status)) return null;
  return {
    year: season.year,
    // What they owe: their tier's amount, else the standard amount (null until it's set).
    owedCents: row.tierCents ?? season.duesAmountCents,
    tierName: row.tierName,
    instructions: season.paymentInstructions,
    status: (row.status ?? "unpaid") as DuesStatus,
    paidAmountCents: row.amountCents,
    paidOn: row.paidOn,
  };
}
