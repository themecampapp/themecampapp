// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import type { Db } from "./db.server";
import { EDITABLE } from "./email-templates";
import { describeHistory } from "./history-labels";

export type HistoryEntry = {
  id: string;
  at: string;
  text: string;
  failed?: boolean;
  // Who did it: the person themselves, another person (named), nobody (the app or an import),
  // or an email the app sent them (the action that caused it is its own entry).
  by:
    | { kind: "self" }
    | { kind: "person"; id: string; name: string }
    | { kind: "app" }
    | { kind: "email" };
};

const EMAIL_NAME: Record<string, string> = {
  ...Object.fromEntries(EDITABLE.map((t) => [t.kind, t.name])),
  magic_link: "Sign-in link",
};

// Audit actions only a Treasurer (or Admin) may see: who paid what is private to them, as on
// the roster and in the export.
const DUES_ACTIONS = ["dues_updated"];

// Everything recorded about one person, newest first: rows about them, bulk actions and join
// inquiries that name them, and emails sent to their address (sign-in links live in the
// Sign-in log instead). Without `dues`, dues entries are left out in the query itself, so
// they're never counted, paged or sent to the page.
export async function personHistory(
  db: Db,
  personId: string,
  limit: number,
  { dues }: { dues: boolean },
) {
  const rows = await db.execute<{
    id: string;
    at: string;
    action: string;
    before: unknown;
    after: unknown;
    actor_id: string | null;
    actor_name: string | null;
    email_status: string | null;
    email_error: string | null;
  }>(sql`
    select * from (
      select a.id::text, to_json(a.created_at) #>> '{}' as at, a.created_at as sort_at,
        a.action, a.before, a.after,
        a.actor_person_id::text as actor_id, coalesce(ap.playa_name, ap.legal_name) as actor_name,
        null as email_status, null as email_error
      from audit_log a
      left join person ap on ap.id = a.actor_person_id
      where ((a.subject_type = 'person' and a.subject_id = ${personId})
        or (a.action in ('bulk_invite_sent', 'rsvp_nudge_sent')
          and a.subject_id is null and a.after -> 'personIds' ? ${personId})
        or (a.subject_type = 'inquiry' and a.after ->> 'personId' = ${personId}))
        and (${dues} or a.action not in (${sql.join(
          DUES_ACTIONS.map((x) => sql`${x}`),
          sql`, `,
        )}))
      union all
      select s.id::text, to_json(s.created_at) #>> '{}', s.created_at, s.kind, null, null,
        null, null, s.status, s.error
      from send_log s
      where s.kind <> 'magic_link'
        and lower(s.recipient) = (select lower(email) from person where id = ${personId})
    ) h
    order by sort_at desc
    limit ${limit + 1}
  `);
  const HELD: Record<string, string> = {
    capped: "the camp reached its daily email limit",
    paused: "the camp's email is paused",
    skipped: "not sent from this environment or while the camp is suspended",
  };
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  const entries: HistoryEntry[] = rows.slice(0, limit).map((r) => {
    if (r.email_status) {
      const name = EMAIL_NAME[r.action] ?? r.action.replace(/_/g, " ");
      // A suppressed address reads as a failure, without the reason: the suppression list is
      // every camp's, so it mustn't tell this camp about another's mail.
      const failed = r.email_status === "failed" || r.email_status === "suppressed";
      const detail = r.email_status === "failed" && r.email_error ? ` (${r.email_error})` : "";
      return {
        id: r.id,
        at: r.at,
        text: failed
          ? `Email failed to send: ${name}${detail}`
          : r.email_status === "sent"
            ? `Email sent: ${name}`
            : `Email not sent: ${name} (${HELD[r.email_status] ?? "held back"})`,
        failed,
        by: { kind: "email" },
      };
    }
    return {
      id: r.id,
      at: r.at,
      text: describeHistory(r.action, parse(r.before), parse(r.after), { view: "person" }),
      by: !r.actor_id
        ? { kind: "app" }
        : r.actor_id === personId
          ? { kind: "self" }
          : { kind: "person", id: r.actor_id, name: r.actor_name ?? "someone" },
    };
  });
  return { entries, more: rows.length > limit };
}
