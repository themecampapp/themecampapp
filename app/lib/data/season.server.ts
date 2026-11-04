// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, campSettings, participation } from "~/db/schema";
import type { Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { copyDuesTiers } from "./dues.server";
import { currentYear } from "./participation.server";

// Season rollover (issue #4). The current season is the camp's camp_settings.current_year, read
// everywhere through the SQL function current_year(). Rolling over records who actually came
// to the season that's ending (their camp year), creates the next season, and switches to it,
// in one transaction. Nothing is deleted, so an Admin can switch back.

const refuse = (reason: string, status = 400) => data({ reason }, { status });

function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin) throw refuse("admin_only", 403);
}

export type AttendanceRow = {
  personId: string;
  name: string;
  legalName: string;
  intent: "going" | "leaning_yes";
  came: boolean; // pre-ticked: already recorded, else Going
};

// Everyone active who was Going or Leaning yes this season, for the "who came?" review.
export async function attendanceReview(db: Db): Promise<AttendanceRow[]> {
  const rows = await db.execute<{
    person_id: string;
    legal_name: string;
    playa_name: string | null;
    intent: "going" | "leaning_yes";
    attended: boolean | null;
  }>(sql`
    select p.id as person_id, p.legal_name, p.playa_name, pa.intent, pa.attended
    from participation pa
    join person p on p.id = pa.person_id and p.active
    where pa.burn_id = (select id from burn where year = current_year())
      and pa.intent in ('going', 'leaning_yes')
    order by pa.intent, lower(coalesce(p.playa_name, p.legal_name))
  `);
  return rows.map((r) => ({
    personId: r.person_id,
    name: r.playa_name ?? r.legal_name,
    legalName: r.legal_name,
    intent: r.intent,
    came: r.attended ?? r.intent === "going",
  }));
}

export async function seasons(db: Db): Promise<number[]> {
  const rows = await db.select({ year: burn.year }).from(burn).orderBy(burn.year);
  return rows.map((r) => r.year);
}

// Records attendance for `fromYear` and switches to fromYear + 1. `fromYear` must still be
// the current season (so a double submit can't roll over twice). Only people on the review
// list are changed: ticked -> came, unticked -> didn't come.
export async function rollOver(db: Db, actor: Viewer, input: { fromYear: number; came: string[] }) {
  assertAdmin(actor);
  const review = await attendanceReview(db);
  const listed = new Set(review.map((r) => r.personId));
  const came = new Set(input.came.filter((id) => listed.has(id)));
  const toYear = input.fromYear + 1;

  await db.transaction(async (tx) => {
    // Lock the camp's settings row so two Admins rolling over at once can't both succeed.
    // Row-level security leaves only this camp's row visible.
    const [settings] = await tx.select().from(campSettings).for("update");
    if (!settings || settings.currentYear !== input.fromYear) throw refuse("season_changed", 409);

    const [from] = await tx.select().from(burn).where(eq(burn.year, input.fromYear));
    if (!from) throw refuse("season_changed", 409);
    const prior = new Map(
      (
        await tx
          .select({ personId: participation.personId, attended: participation.attended })
          .from(participation)
          .where(eq(participation.burnId, from.id))
      ).map((r) => [r.personId, r.attended]),
    );
    for (const personId of listed) {
      const attended = came.has(personId);
      await tx
        .update(participation)
        .set({ attended, updatedByPersonId: actor.personId, updatedAt: new Date() })
        .where(and(eq(participation.personId, personId), eq(participation.burnId, from.id)));
      // Also in each person's History, so it's clear who marked them and when.
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "camp_year_set",
        subjectType: "person",
        subjectId: personId,
        before: { year: input.fromYear, attended: prior.get(personId) ?? null },
        after: { year: input.fromYear, attended, via: "rollover" },
      });
    }
    await tx.insert(burn).values({ year: toYear }).onConflictDoNothing();
    const [to] = await tx.select({ id: burn.id }).from(burn).where(eq(burn.year, toYear));
    await copyDuesTiers(tx, from.id, to.id);
    await tx
      .update(campSettings)
      .set({ currentYear: toYear, updatedAt: new Date() })
      .where(eq(campSettings.campId, settings.campId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "season_rolled_over",
      subjectType: "burn",
      subjectId: from.id,
      before: { year: input.fromYear },
      after: { year: toYear, came: came.size, didNotCome: listed.size - came.size },
    });
  });
  return { toYear, came: came.size, didNotCome: listed.size - came.size };
}

// Undo, or a correction: make an existing season current again. Recorded attendance stays.
export async function switchSeason(db: Db, actor: Viewer, year: number) {
  assertAdmin(actor);
  const from = await currentYear(db);
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(burn).where(eq(burn.year, year));
    if (!target) throw refuse("bad_season");
    await tx
      .update(campSettings)
      .set({ currentYear: year, updatedAt: new Date() })
      .where(eq(campSettings.campId, target.campId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "season_switched",
      subjectType: "burn",
      subjectId: target.id,
      before: { year: from },
      after: { year },
    });
  });
}

// Issue #31: past seasons an Admin sets up by hand, back to 1996, so a camp's history (who
// camped which year) can be recorded. They're history only: the app never plans them.
export const FIRST_PAST_SEASON = 1996;

export type PastSeason = { year: number; camped: number; inUse: boolean };

// Every season before the current one, newest first, with how many camped that year.
export async function pastSeasonList(db: Db): Promise<PastSeason[]> {
  const rows = await db.execute<{ year: number; camped: number; rows: number }>(sql`
    select b.year,
      (select count(*)::int from participation pa where pa.burn_id = b.id and pa.attended) as camped,
      (select count(*)::int from participation pa where pa.burn_id = b.id) as rows
    from burn b where b.year < current_year() order by b.year desc`);
  return rows.map((r) => ({
    year: Number(r.year),
    camped: Number(r.camped),
    inUse: Number(r.rows) > 0,
  }));
}

export async function addPastSeason(db: Db, actor: Viewer, year: number) {
  assertAdmin(actor);
  const current = await currentYear(db);
  if (!Number.isInteger(year) || year < FIRST_PAST_SEASON || year >= current) {
    throw refuse("past_season_range");
  }
  await db.transaction(async (tx) => {
    const [exists] = await tx.select({ id: burn.id }).from(burn).where(eq(burn.year, year));
    if (exists) throw refuse("past_season_exists", 409);
    const [row] = await tx.insert(burn).values({ year }).returning({ id: burn.id });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "past_season_added",
      subjectType: "burn",
      subjectId: row.id,
      after: { year },
    });
  });
}

// Only a past season nobody has any record in can be removed (a mistyped year).
export async function removePastSeason(db: Db, actor: Viewer, year: number) {
  assertAdmin(actor);
  if (!Number.isInteger(year) || year >= (await currentYear(db))) {
    throw refuse("past_season_range");
  }
  await db.transaction(async (tx) => {
    const [season] = await tx.select().from(burn).where(eq(burn.year, year)).for("update");
    if (!season) throw refuse("not_found", 404);
    const [{ n }] = await tx.execute<{ n: number }>(sql`
      select (select count(*) from participation where burn_id = ${season.id})
        + (select count(*) from volunteer_signup where burn_id = ${season.id})
        + (select count(*) from sap_pass where burn_id = ${season.id})
        + (select count(*) from key_date where burn_id = ${season.id}) as n`);
    if (Number(n) > 0) throw refuse("past_season_in_use", 409);
    await tx.delete(burn).where(eq(burn.id, season.id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "past_season_removed",
      subjectType: "burn",
      subjectId: season.id,
      before: { year },
    });
  });
}

export type SeasonCamper = { personId: string; name: string; active: boolean; camped: boolean };

// Everyone the camp has (people who've left too: they may have camped back then), and whether
// they camped in `year`. Active people first, each group by name.
export async function pastSeasonRoster(db: Db, year: number): Promise<SeasonCamper[] | null> {
  const [season] = await db.select().from(burn).where(eq(burn.year, year));
  if (!season || year >= (await currentYear(db))) return null;
  const rows = await db.execute<{
    id: string;
    legal_name: string;
    playa_name: string | null;
    active: boolean;
    camped: boolean | null;
  }>(sql`
    select p.id, p.legal_name, p.playa_name, p.active, pa.attended as camped
    from person p
    left join participation pa on pa.person_id = p.id and pa.burn_id = ${season.id}
    order by p.active desc, lower(coalesce(p.playa_name, p.legal_name))`);
  return rows.map((r) => ({
    personId: r.id,
    name: r.playa_name ? `${r.playa_name} (${r.legal_name})` : r.legal_name,
    active: r.active,
    camped: r.camped === true,
  }));
}

// Who camped in a past season, from the checklist: ticked people become "camped", and anyone
// unticked who was recorded as camping goes back to unknown. Anything else recorded about
// them that year (a "didn't come", a pre-burn intent) is left as it is.
export async function setSeasonCampers(
  db: Db,
  actor: Viewer,
  year: number,
  camped: string[],
): Promise<{ added: number; removed: number }> {
  assertAdmin(actor);
  if (!Number.isInteger(year) || year >= (await currentYear(db))) {
    throw refuse("past_season_range");
  }
  return db.transaction(async (tx) => {
    const [season] = await tx.select().from(burn).where(eq(burn.year, year));
    if (!season) throw refuse("not_found", 404);
    const people = new Set(
      (await tx.execute<{ id: string }>(sql`select id from person`)).map((r) => r.id),
    );
    const want = new Set(camped.filter((id) => people.has(id)));
    const before = await tx
      .select({ personId: participation.personId, attended: participation.attended })
      .from(participation)
      .where(eq(participation.burnId, season.id))
      .for("update");
    const was = new Map(before.map((r) => [r.personId, r.attended]));
    let added = 0;
    let removed = 0;
    for (const personId of people) {
      const now = was.get(personId) ?? null;
      const next = want.has(personId) ? true : now === true ? null : now;
      if (next === now) continue;
      await tx
        .insert(participation)
        .values({ personId, burnId: season.id, attended: next, updatedByPersonId: actor.personId })
        .onConflictDoUpdate({
          target: [participation.personId, participation.burnId],
          set: { attended: next, updatedByPersonId: actor.personId, updatedAt: new Date() },
        });
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "camp_year_set",
        subjectType: "person",
        subjectId: personId,
        before: { year, attended: now },
        after: { year, attended: next },
      });
      if (next) added++;
      else removed++;
    }
    return { added, removed };
  });
}
