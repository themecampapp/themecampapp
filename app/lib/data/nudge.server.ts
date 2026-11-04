// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { inviteUrl } from "../invites.server";
import { type BatchResult, sendMail, sendMailBatch } from "../mail.server";

// "Send RSVP nudge email" (issue #3): a friendly fixed-template email asking invited campers
// who haven't answered to RSVP. The same person is nudged at most once every few days, however
// often a Lead clicks, and every send is audited and logged.

type MailEnv = import("../mail.server").MailEnv;

export const NUDGE_COOLDOWN_DAYS = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NudgeCandidate = {
  personId: string;
  email: string;
  lastNudgedAt: string | null;
  canNudge: boolean; // false while inside the cooldown
};

// Active people who were invited (or have signed in) but have no RSVP this season, with a
// valid email: the roster's "No RSVP" list.
export async function nudgeCandidates(db: Db): Promise<NudgeCandidate[]> {
  const rows = await db.execute<{ id: string; email: string; last: string | null }>(sql`
    select p.id, p.email,
      (select max(s.created_at)::text from send_log s
        where s.kind = 'rsvp_nudge' and s.status = 'sent' and s.recipient = p.email) as last
    from person p
    left join participation pa on pa.person_id = p.id
      and pa.burn_id = (select id from burn where year = current_year())
    where p.active and p.email is not null and pa.intent is null
      and (p.auth_user_id is not null
        or exists (select 1 from invite i where i.person_id = p.id and i.status = 'pending'))
  `);
  const cutoff = Date.now() - NUDGE_COOLDOWN_DAYS * 86400_000;
  return rows
    .filter((r) => EMAIL_RE.test(r.email))
    .map((r) => ({
      personId: r.id,
      email: r.email,
      lastNudgedAt: r.last ? new Date(r.last).toISOString() : null,
      canNudge: !r.last || new Date(r.last).getTime() < cutoff,
    }));
}

// Nudges the given people, skipping anyone who isn't a candidate or was nudged recently.
export async function sendRsvpNudges(db: Db, env: MailEnv, actor: Viewer, personIds: string[]) {
  assertAccess(actor, "roster");
  const wanted = new Set(personIds);
  const candidates = (await nudgeCandidates(db)).filter((c) => wanted.has(c.personId));
  const eligible = candidates.filter((c) => c.canNudge);
  const skipped = personIds.length - eligible.length;
  if (!eligible.length) return { sent: 0, skipped, failed: 0, held: {}, failedTo: [] as string[] };

  let result: BatchResult;
  if (eligible.length === 1) {
    const [c] = eligible;
    const status = await sendMail(db, env, "rsvp_nudge", c.email, { url: inviteUrl(env, c.email) });
    result =
      status === "sent"
        ? { sent: 1, failed: [], held: {} }
        : {
            sent: 0,
            failed: [c.email],
            // As in sendMailBatch: a suppressed address is reported as a plain failure.
            held: status === "failed" || status === "suppressed" ? {} : { [status]: 1 },
          };
  } else {
    result = await sendMailBatch(
      db,
      env,
      "rsvp_nudge",
      eligible.map((c) => ({ to: c.email, url: inviteUrl(env, c.email) })),
    );
  }
  const heldCount = Object.values(result.held).reduce((n, v) => n + (v ?? 0), 0);
  const failed = result.failed.length - heldCount;
  await audit(db, {
    actorPersonId: actor.personId,
    action: "rsvp_nudge_sent",
    subjectType: "person",
    subjectId: eligible.length === 1 ? eligible[0].personId : null,
    after: {
      count: result.sent,
      failed,
      held: result.held,
      personIds: eligible.map((c) => c.personId),
    },
  });
  return { sent: result.sent, skipped, failed, held: result.held, failedTo: result.failed };
}

// What sending RSVP nudges to these people would do (the roster's selection, Lead workspace
// plan Unit 8): who'd get one, who's skipped because they were nudged recently, and who can't
// be nudged at all (and why). Worked out again when the Lead presses Send.
export async function nudgePreview(
  db: Db,
  selected: Array<{
    id: string;
    name: string;
    rsvp: string;
    invited: boolean;
    email: string | null;
  }>,
) {
  const candidates = new Map((await nudgeCandidates(db)).map((c) => [c.personId, c]));
  const send: Array<{ id: string; name: string; email: string }> = [];
  const cooldown: Array<{ id: string; name: string; lastNudgedAt: string }> = [];
  const notEligible: Array<{ id: string; name: string; reason: string }> = [];
  for (const p of selected) {
    const c = candidates.get(p.id);
    if (c?.canNudge) send.push({ id: p.id, name: p.name, email: c.email });
    else if (c) cooldown.push({ id: p.id, name: p.name, lastNudgedAt: c.lastNudgedAt as string });
    else {
      notEligible.push({
        id: p.id,
        name: p.name,
        reason:
          p.rsvp !== "none"
            ? "already RSVP'd"
            : !p.email
              ? "no email address"
              : !p.invited
                ? "not invited yet"
                : "no valid email address",
      });
    }
  }
  return { send, cooldown, notEligible };
}
