// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNull, sql } from "drizzle-orm";
import { keyDate } from "~/db/schema";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { type KeyDateAction, REMIND_DAYS_BEFORE } from "../key-dates";
import { campName, sendMailBatch } from "../mail.server";
import { formatDay } from "../roster-filters";
import { getCampSettings } from "./camp-settings.server";
import { actionHidden } from "./key-dates.server";
import { type SeasonRow, seasonRows } from "./season-roster.server";

// Key-date reminders (R63, U19). A Lead ticks "Email a reminder" on a date tied to something
// members do; a few days before it, the camp Worker's daily job emails the people who haven't
// done it yet, once. Who "hasn't done it" is the roster's own list for that action, so the
// reminder goes to exactly the people a Lead would see there.

type MailEnv = import("../mail.server").MailEnv;

// Someone nudged to RSVP this recently (by a Lead, or another RSVP reminder) isn't asked again
// by an RSVP reminder. Reminders for different things don't hold each other back: each date
// sends once, so a camper gets at most one email per date a Lead chose to remind about.
export const REMINDER_COOLDOWN_DAYS = 3;

const coming = (r: SeasonRow) => r.rsvp === "going" || r.rsvp === "leaning_yes";

const WAITING: Record<KeyDateAction, (r: SeasonRow) => boolean> = {
  rsvp_by: (r) => r.rsvp === "none" && r.invited,
  tickets_close: (r) => coming(r) && r.ticket.state === "none",
  dues_due: (r) => coming(r) && r.dues === "unpaid",
};

const ASK: Record<KeyDateAction, string> = {
  rsvp_by: "We don't have your RSVP yet. Let us know whether you're coming this year.",
  tickets_close:
    "You're coming this year, but haven't asked for tickets (or told us you have them) yet.",
  dues_due: "Your dues for this year aren't marked paid yet.",
};

// The people a date's reminder goes to: the roster's list for its action, with a valid email,
// minus (for RSVPs) anyone nudged recently. One email per address.
export async function reminderRecipients(db: Db, action: KeyDateAction): Promise<string[]> {
  const [season] = await db.execute<{ locked: boolean; dues_set: boolean }>(sql`
    select ticket_requests_locked as locked, dues_amount_cents is not null as dues_set
    from burn where year = current_year()`);
  if (!season) return [];
  if (action === "tickets_close" && season.locked) return [];
  if (action === "dues_due" && !season.dues_set) return [];
  const recent = new Set(
    action !== "rsvp_by"
      ? []
      : (
          await db.execute<{ r: string }>(sql`
            select distinct lower(recipient) as r from send_log
            where kind = 'rsvp_nudge' and status = 'sent'
              and created_at > now() - make_interval(days => ${REMINDER_COOLDOWN_DAYS})`)
        ).map((x) => x.r),
  );
  const emails = (await seasonRows(db, { dues: true, contact: true })) // every row, dues included: the job acts for the camp
    .filter(WAITING[action])
    .map((r) => r.email?.toLowerCase() ?? "")
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !recent.has(e));
  return [...new Set(emails)];
}

export function reminderEmail(
  d: { label: string; date: string; action: KeyDateAction },
  camp: string,
  url: string,
) {
  return {
    subject: `${camp}: ${d.label}, ${formatDay(d.date)}`,
    text: `${ASK[d.action]}\n\n${d.label}: ${formatDay(d.date)}.\n\nYou can do it on the camp site: ${url}`,
  };
}

// The reminders due today for one camp: dates with "remind" on, an action whose feature is on,
// not reminded yet, and coming up within REMIND_DAYS_BEFORE days. Each date is claimed before
// anything is sent, so overlapping runs never send it twice. Returns what was sent, per date.
export async function sendDueReminders(db: Db, env: MailEnv) {
  const { features } = await getCampSettings(db);
  const due = await db.execute<{ id: string; action: KeyDateAction }>(sql`
    select k.id, k.action from key_date k join burn b on b.id = k.burn_id
    where b.year = current_year() and k.remind and k.reminded_at is null
      and k.action is not null
      and k.date between current_date and current_date + ${REMIND_DAYS_BEFORE}::int
    order by k.date, k.label`);
  const results: Array<{ id: string; label: string; sent: number; recipients: number }> = [];
  for (const { id, action } of due) {
    // A date whose feature is off stays unclaimed: it still reminds if switched back on in time.
    if (actionHidden(action, features)) continue;
    const [d] = await db
      .update(keyDate)
      .set({ remindedAt: new Date() })
      .where(and(eq(keyDate.id, id), isNull(keyDate.remindedAt)))
      .returning();
    if (!d?.action) continue;
    const recipients = await reminderRecipients(db, d.action);
    const email = reminderEmail({ ...d, action: d.action }, await campName(db), env.APP_URL);
    const r = recipients.length
      ? await sendMailBatch(
          db,
          env,
          "date_reminder",
          recipients.map((to) => ({ to, url: env.APP_URL })),
          email,
        )
      : { sent: 0, failed: [], held: {} };
    await audit(db, {
      actorPersonId: null,
      action: "key_date_reminded",
      subjectType: "key_date",
      subjectId: id,
      after: {
        label: d.label,
        date: d.date,
        recipients: recipients.length,
        sent: r.sent,
        held: r.held,
      },
    });
    results.push({ id, label: d.label, sent: r.sent, recipients: recipients.length });
  }
  return results;
}
