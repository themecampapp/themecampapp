// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, participation } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { cardLabel } from "../photos.server";
import { currentYear } from "./participation.server";

// Camp history. A "camp year" is a past season (before the current one) where the person's
// participation has attended = true. It's always derived from participation, never cached.

export type CampYearValue = "yes" | "no" | "unknown";

// "2024,2026" -> [2024, 2026]; null or "" -> [].
export const parseYears = (s: string | null): number[] => (s ? s.split(",").map(Number) : []);

// Camp years for each of the given people, ascending. People with none are absent.
export async function campYears(db: Db, personIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!personIds.length) return out;
  // A comma-separated string, not an array: the Worker's client runs with fetch_types off,
  // so Postgres arrays would arrive unparsed.
  const rows = await db.execute<{ person_id: string; years: string }>(sql`
    select pa.person_id, string_agg(b.year::text, ',' order by b.year) as years
    from participation pa join burn b on b.id = pa.burn_id
    where pa.attended and b.year < current_year()
      and pa.person_id in (${sql.join(
        personIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    group by pa.person_id
  `);
  for (const r of rows) out.set(r.person_id, parseYears(r.years));
  return out;
}

// Past seasons that have at least one recorded camper, newest first.
export async function pastYearbookYears(db: Db): Promise<number[]> {
  const rows = await db.execute<{ year: number }>(sql`
    select b.year from burn b
    where b.year < current_year()
      and exists (select 1 from participation pa where pa.burn_id = b.id and pa.attended)
    order by b.year desc
  `);
  return rows.map((r) => Number(r.year));
}

// Every past season the app knows about (for the Lead camp-years editor), ascending.
export async function pastSeasons(db: Db): Promise<number[]> {
  const rows = await db.execute<{ year: number }>(
    sql`select year from burn where year < current_year() order by year`,
  );
  return rows.map((r) => Number(r.year));
}

// Lead correction of one person's past year. Upserts only `attended`, so an imported 2026
// row keeps its pre-burn intent. "unknown" clears it (null) but keeps the row.
export async function setCampYear(
  db: Db,
  actor: Viewer,
  personId: string,
  year: number,
  value: CampYearValue,
) {
  assertAccess(actor, "roster");
  if (!Number.isInteger(year) || year >= (await currentYear(db))) {
    throw data({ reason: "bad_camp_year" }, { status: 400 });
  }
  const attended = value === "yes" ? true : value === "no" ? false : null;
  await db.transaction(async (tx) => {
    const [season] = await tx.select().from(burn).where(eq(burn.year, year));
    if (!season) throw data({ reason: "bad_camp_year" }, { status: 400 });
    const [before] = await tx
      .select({ attended: participation.attended })
      .from(participation)
      .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)))
      .for("update");
    if (!before && attended === null) return;
    if (before && before.attended === attended) return;
    await tx
      .insert(participation)
      .values({ personId, burnId: season.id, attended, updatedByPersonId: actor.personId })
      .onConflictDoUpdate({
        target: [participation.personId, participation.burnId],
        set: { attended, updatedByPersonId: actor.personId, updatedAt: new Date() },
      });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "camp_year_set",
      subjectType: "person",
      subjectId: personId,
      before: { year, attended: before?.attended ?? null },
      after: { year, attended },
    });
  });
}

export type PastYearbook = {
  cards: Array<{ key: string; label: string; secondary: string | null; years: number[] }>;
  names: Array<{ label: string; years: number[] }>;
};

// A past season's Yearbook: active people who camped that year. Those with a photo get a
// card; the rest are listed by name only. Only display labels leave this function: no
// emails, phones, surnames or person ids.
export async function pastYearbook(db: Db, year: number): Promise<PastYearbook> {
  const rows = await db.execute<{
    id: string;
    key: string | null;
    playa_name: string | null;
    legal_name: string;
    show: boolean;
  }>(sql`
    select p.id, p.photo_key as key, p.playa_name, p.legal_name,
      p.yearbook_show_first_name as show
    from person p
    join participation pa on pa.person_id = p.id and pa.attended
    join burn b on b.id = pa.burn_id and b.year = ${year}
    where p.active
  `);
  const years = await campYears(
    db,
    rows.map((r) => r.id),
  );
  const cards: PastYearbook["cards"] = [];
  const names: PastYearbook["names"] = [];
  for (const r of rows) {
    const label = cardLabel({
      playaName: r.playa_name,
      legalName: r.legal_name,
      showFirstName: r.show,
    });
    const y = years.get(r.id) ?? [];
    if (r.key) cards.push({ key: r.key, ...label, years: y });
    else names.push({ label: label.label, years: y });
  }
  const byLabel = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  return { cards: cards.sort(byLabel), names: names.sort(byLabel) };
}
