// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, KEY_DATE_ACTIONS, keyDate } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import { isCalendarDate } from "../dates";
import type { Db } from "../db.server";
import type { Features } from "../features";
import type { KeyDateAction } from "../key-dates";
import { currentSeason } from "./participation.server";

// The season's key dates (R63 display, R64). A date may be tied to something members do; one
// tied to a switched-off feature is hidden. A date tied to an action can also email a
// reminder to those who haven't done it (reminders.server.ts).

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertLead(actor: Viewer) {
  assertAccess(actor, "announcements");
}

// Whether a date's action belongs to a feature that's off. Ticket requests and RSVPs are
// always on; dues can be switched off.
export const actionHidden = (action: KeyDateAction | null, features: Features) =>
  action === "dues_due" && !features.dues;

export type KeyDateInput = { label: string; date: string; action: string; remind?: boolean };

function clean(input: KeyDateInput) {
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!label) throw refuse("key_date_label_needed");
  if (label.length > 80) throw refuse("key_date_label_too_long");
  const date = input.date.trim();
  if (!isCalendarDate(date)) {
    throw refuse("key_date_date_needed");
  }
  const action = input.action ? (input.action as KeyDateAction) : null;
  if (action && !KEY_DATE_ACTIONS.includes(action)) throw refuse("key_date_action_unknown");
  // Only a date tied to something members do has anyone to remind.
  return { label, date, action, remind: !!input.remind && action !== null };
}

// This season's dates, all of them (the Lead page).
export async function seasonDates(db: Db) {
  return db
    .select({
      id: keyDate.id,
      label: keyDate.label,
      date: keyDate.date,
      action: keyDate.action,
      remind: keyDate.remind,
      remindedAt: keyDate.remindedAt,
    })
    .from(keyDate)
    .innerJoin(burn, eq(burn.id, keyDate.burnId))
    .where(sql`${burn.year} = current_year()`)
    .orderBy(asc(keyDate.date), asc(keyDate.label));
}

// This season's dates from today on, minus those whose feature is off (the home page).
export async function upcomingDates(db: Db, features: Features, limit = 8) {
  const rows = await db
    .select({ id: keyDate.id, label: keyDate.label, date: keyDate.date, action: keyDate.action })
    .from(keyDate)
    .innerJoin(burn, eq(burn.id, keyDate.burnId))
    .where(and(sql`${burn.year} = current_year()`, gte(keyDate.date, sql`current_date`)))
    .orderBy(asc(keyDate.date), asc(keyDate.label));
  return rows.filter((r) => !actionHidden(r.action, features)).slice(0, limit);
}

// R64: a passed "ticket requests close" date while requests are still open. The app never
// locks them itself; it reminds Leads to. Returns the latest such date, or null.
export async function lockReminder(db: Db): Promise<string | null> {
  const [row] = await db.execute<{ date: string | null }>(sql`
    select max(k.date)::text as date from key_date k
    join burn b on b.id = k.burn_id
    where b.year = current_year() and not b.ticket_requests_locked
      and k.action = 'tickets_close' and k.date < current_date`);
  return row?.date ?? null;
}

export async function addKeyDate(db: Db, actor: Viewer, input: KeyDateInput) {
  assertLead(actor);
  const values = clean(input);
  const season = await currentSeason(db);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(keyDate)
      .values({ ...values, burnId: season.id })
      .returning({ id: keyDate.id });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "key_date_added",
      subjectType: "key_date",
      subjectId: row.id,
      after: values,
    });
  });
}

export async function editKeyDate(db: Db, actor: Viewer, id: string, input: KeyDateInput) {
  assertLead(actor);
  if (!ID_RE.test(id)) throw refuse("key_date_not_found", 404);
  const values = clean(input);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(keyDate).where(eq(keyDate.id, id)).for("update");
    if (!before) throw refuse("key_date_not_found", 404);
    await tx
      .update(keyDate)
      // A date moved to a new day reminds again before the new day.
      .set({
        ...values,
        ...(values.date !== before.date ? { remindedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(keyDate.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "key_date_edited",
      subjectType: "key_date",
      subjectId: id,
      before: {
        label: before.label,
        date: before.date,
        action: before.action,
        remind: before.remind,
      },
      after: values,
    });
  });
}

export async function removeKeyDate(db: Db, actor: Viewer, id: string) {
  assertLead(actor);
  if (!ID_RE.test(id)) throw refuse("key_date_not_found", 404);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(keyDate).where(eq(keyDate.id, id)).for("update");
    if (!before) throw refuse("key_date_not_found", 404);
    await tx.delete(keyDate).where(eq(keyDate.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "key_date_removed",
      subjectType: "key_date",
      subjectId: id,
      before: { label: before.label, date: before.date, action: before.action },
    });
  });
}
