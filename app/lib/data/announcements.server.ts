// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { data } from "react-router";
import { announcement } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { BODY_MAX, MAX_DAYS, TITLE_MAX } from "../announcements";
import { audit } from "../audit.server";
import { isCalendarDate } from "../dates";
import type { Db } from "../db.server";
import { campName, sendMailBatch } from "../mail.server";
import { stripLinks } from "../strip-links";

// Home-page announcements (R61). Any Lead posts, edits or removes any of them; each shows to
// active members until its "show until" date, which may be at most MAX_DAYS ahead. Every
// change is audited. Each can also be emailed, once, to the season's members (below).

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertLead(actor: Viewer) {
  assertAccess(actor, "announcements");
}

export type AnnouncementInput = { title: string; body: string; showUntil: string };

// Today and the latest allowed date, as the database sees them (so every check agrees).
async function window(db: Db) {
  const [row] = await db.execute<{ today: string; latest: string }>(sql`
    select current_date::text as today, (current_date + ${MAX_DAYS}::int)::text as latest`);
  return row;
}

async function clean(db: Db, input: AnnouncementInput) {
  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title) throw refuse("announcement_title_needed");
  if (title.length > TITLE_MAX) throw refuse("announcement_title_too_long");
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (body.length > BODY_MAX) throw refuse("announcement_body_too_long");
  const showUntil = input.showUntil.trim();
  if (!isCalendarDate(showUntil)) {
    throw refuse("announcement_date_needed");
  }
  const { today, latest } = await window(db);
  if (showUntil < today) throw refuse("announcement_date_past");
  if (showUntil > latest) throw refuse("announcement_date_too_far");
  return { title, body, showUntil };
}

// Current announcements, newest first.
export async function currentAnnouncements(db: Db) {
  return db
    .select({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      showUntil: announcement.showUntil,
      createdAt: announcement.createdAt,
      emailedAt: announcement.emailedAt,
      emailedCount: announcement.emailedCount,
    })
    .from(announcement)
    .where(gte(announcement.showUntil, sql`current_date`))
    .orderBy(desc(announcement.createdAt));
}

export async function postAnnouncement(db: Db, actor: Viewer, input: AnnouncementInput) {
  assertLead(actor);
  const values = await clean(db, input);
  return db.transaction(async (tx) => {
    // The same announcement twice is almost always a slip (a double click, or Post pressed
    // again): refuse it while the first is still showing. The lock makes two posts arriving
    // together take turns, so the second sees the first.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('announcement:' || current_camp_id()))`,
    );
    const [same] = await tx.execute<{ id: string }>(sql`
      select id from announcement
      where show_until >= current_date
        and lower(title) = lower(${values.title}) and body = ${values.body}
      limit 1`);
    if (same) throw refuse("announcement_duplicate", 409);
    const [row] = await tx
      .insert(announcement)
      .values({ ...values, createdByPersonId: actor.personId, updatedByPersonId: actor.personId })
      .returning({ id: announcement.id });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "announcement_posted",
      subjectType: "announcement",
      subjectId: row.id,
      after: { title: values.title, showUntil: values.showUntil },
    });
    return row;
  });
}

export async function editAnnouncement(
  db: Db,
  actor: Viewer,
  id: string,
  input: AnnouncementInput,
) {
  assertLead(actor);
  if (!ID_RE.test(id)) throw refuse("announcement_not_found", 404);
  const values = await clean(db, input);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(announcement)
      .where(and(eq(announcement.id, id), gte(announcement.showUntil, sql`current_date`)))
      .for("update");
    if (!before) throw refuse("announcement_not_found", 404);
    await tx
      .update(announcement)
      .set({ ...values, updatedByPersonId: actor.personId, updatedAt: new Date() })
      .where(eq(announcement.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "announcement_edited",
      subjectType: "announcement",
      subjectId: id,
      before: { title: before.title, showUntil: before.showUntil },
      after: { title: values.title, showUntil: values.showUntil },
    });
  });
}

export async function removeAnnouncement(db: Db, actor: Viewer, id: string) {
  assertLead(actor);
  if (!ID_RE.test(id)) throw refuse("announcement_not_found", 404);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(announcement)
      .where(eq(announcement.id, id))
      .for("update");
    if (!before) throw refuse("announcement_not_found", 404);
    await tx.delete(announcement).where(eq(announcement.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "announcement_removed",
      subjectType: "announcement",
      subjectId: id,
      before: { title: before.title, showUntil: before.showUntil },
    });
  });
}

export async function latestShowUntil(db: Db) {
  return (await window(db)).latest;
}

// ---- The optional email (R62, U19) -----------------------------------------------------------

type MailEnv = import("../mail.server").MailEnv;

// Who an announcement email goes to: this season's members, active, with an email, except
// anyone who said they're not going. Those who haven't RSVP'd count if they've been invited.
// One email per address (couples sharing one get a single copy).
export async function announcementRecipients(db: Db): Promise<string[]> {
  const rows = await db.execute<{ email: string }>(sql`
    select distinct lower(p.email) as email
    from person p
    left join participation pa on pa.person_id = p.id
      and pa.burn_id = (select id from burn where year = current_year())
    where p.active and p.email is not null
      and (pa.intent is null or pa.intent <> 'not_going')
      and (pa.id is not null or p.auth_user_id is not null or exists (
        select 1 from invite i where i.person_id = p.id and i.status = 'pending'))`);
  return rows.map((r) => r.email).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

// The email exactly as it goes out: the title and body with links stripped, and the one link
// the system adds (the camp site, where the announcement shows with its links).
export function announcementEmail(a: { title: string; body: string }, camp: string, url: string) {
  const title = stripLinks(a.title);
  const body = stripLinks(a.body);
  return {
    subject: `${camp}: ${title.text}`,
    text: `${body.text ? `${body.text}\n\n` : ""}Read it on the camp site: ${url}`,
    removed: title.removed + body.removed,
  };
}

// An announcement that can still be emailed (current, and not emailed yet), or null.
export async function emailable(db: Db, id: string) {
  if (!ID_RE.test(id)) return null;
  const [a] = await db
    .select()
    .from(announcement)
    .where(and(eq(announcement.id, id), gte(announcement.showUntil, sql`current_date`)));
  return a && !a.emailedAt ? a : null;
}

// Sends it, once: the announcement is claimed first (emailed_at set), so a second press, or a
// second Lead at the same moment, sends nothing. Counts against the camp's daily limit like an
// invite; whatever doesn't fit isn't sent, and the Lead is told how many went.
export async function emailAnnouncement(db: Db, env: MailEnv, actor: Viewer, id: string) {
  assertLead(actor);
  if (!ID_RE.test(id)) throw refuse("announcement_not_found", 404);
  const [claimed] = await db
    .update(announcement)
    .set({ emailedAt: new Date(), emailedByPersonId: actor.personId })
    .where(
      and(
        eq(announcement.id, id),
        isNull(announcement.emailedAt),
        gte(announcement.showUntil, sql`current_date`),
      ),
    )
    .returning();
  if (!claimed) throw refuse("announcement_already_emailed", 409);
  const recipients = await announcementRecipients(db);
  const url = env.APP_URL;
  const email = announcementEmail(claimed, await campName(db), url);
  const result = await sendMailBatch(
    db,
    env,
    "announcement",
    recipients.map((to) => ({ to, url })),
    { subject: email.subject, text: email.text },
  );
  await db.transaction(async (tx) => {
    await tx.update(announcement).set({ emailedCount: result.sent }).where(eq(announcement.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "announcement_emailed",
      subjectType: "announcement",
      subjectId: id,
      after: {
        title: claimed.title,
        recipients: recipients.length,
        sent: result.sent,
        held: result.held,
        linksRemoved: email.removed,
      },
    });
  });
  return { recipients: recipients.length, ...result };
}
