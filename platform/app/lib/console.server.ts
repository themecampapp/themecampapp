// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { data } from "react-router";
import type { Operator } from "./context.server";

// The operator console's reads and actions (R16, R38, R41, R42). Reads are counts and camp
// status only: camp_counts() is the one read across camps, and nothing here selects a member's
// name, contact details or anything a camp wrote. Every action is written to operator_log;
// suspending or restoring also writes the camp's own audit log, with that camp set.

export type CampRow = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: string;
  deleteAfter: string | null;
  createdAt: string;
  dailySendCap: number;
  sendingPaused: boolean;
  members: number;
  invitesPending: number;
  emailsSent7d: number;
  bounces7d: number;
  complaints7d: number;
  lastActivity: string | null;
};

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function listCamps(sql: postgres.Sql, id?: string): Promise<CampRow[]> {
  const rows = await sql<CampRow[]>`
    select c.id, c.slug, c.name, c.kind, c.status, c.delete_after::text as "deleteAfter",
      c.created_at::text as "createdAt",
      c.daily_send_cap as "dailySendCap", c.sending_paused as "sendingPaused",
      n.members, n.invites_pending as "invitesPending", n.emails_sent_7d as "emailsSent7d",
      n.bounces_7d as "bounces7d", n.complaints_7d as "complaints7d",
      n.last_activity::text as "lastActivity"
    from camp c join camp_counts() n on n.camp_id = c.id
    ${id ? sql`where c.id = ${id}` : sql``}
    order by c.created_at`;
  return rows;
}

export async function getCamp(sql: postgres.Sql, id: string): Promise<CampRow | null> {
  if (!ID_RE.test(id)) return null;
  return (await listCamps(sql, id))[0] ?? null;
}

async function log(
  tx: postgres.TransactionSql,
  operator: Operator,
  kind: "console_action" | "database_access",
  campId: string | null,
  action: string,
  detail: string,
) {
  await tx`
    insert into operator_log (operator_id, kind, subject_camp_id, action, detail)
    values (${operator.id}, ${kind}, ${campId}, ${action}, ${detail})`;
}

export async function setLimits(
  sql: postgres.Sql,
  operator: Operator,
  id: string,
  input: { dailySendCap: string; sendingPaused: boolean },
) {
  if (!ID_RE.test(id)) throw refuse("camp_not_found", 404);
  const cap = Number(input.dailySendCap);
  if (!Number.isInteger(cap) || cap < 0 || cap > 10_000) throw refuse("cap_range");
  await sql.begin(async (tx) => {
    const [before] = await tx<{ daily_send_cap: number; sending_paused: boolean }[]>`
      select daily_send_cap, sending_paused from camp where id = ${id} for update`;
    if (!before) throw refuse("camp_not_found", 404);
    await tx`update camp set daily_send_cap = ${cap}, sending_paused = ${input.sendingPaused}
      where id = ${id}`;
    await log(
      tx,
      operator,
      "console_action",
      id,
      "limits_set",
      `daily cap ${before.daily_send_cap} → ${cap}; sending ${before.sending_paused ? "paused" : "on"} → ${input.sendingPaused ? "paused" : "on"}`,
    );
  });
}

// Suspends or restores a camp (R16). Returns what's needed to tell its Admins.
export async function setStatus(
  sql: postgres.Sql,
  operator: Operator,
  id: string,
  to: "suspended" | "active",
  rawReason: string,
): Promise<{ name: string; slug: string; adminEmails: string[]; reason: string }> {
  if (!ID_RE.test(id)) throw refuse("camp_not_found", 404);
  const reason = rawReason.trim().replace(/\r\n?/g, "\n");
  if (!reason) throw refuse("reason_needed");
  if (reason.length > 1000) throw refuse("reason_too_long");
  return (await sql.begin(async (tx) => {
    const from = to === "suspended" ? "active" : "suspended";
    const [c] = await tx<{ name: string; slug: string }[]>`
      update camp set status = ${to} where id = ${id} and status = ${from}
      returning name, slug`;
    if (!c) throw refuse(to === "suspended" ? "not_active" : "not_suspended", 409);
    const action = to === "suspended" ? "camp_suspended" : "camp_restored";
    await log(tx, operator, "console_action", id, action, reason);
    // The camp's own audit log, acting as that camp (row-level security applies).
    await tx`select set_config('app.camp_id', ${id}, true)`;
    await tx`
      insert into audit_log (actor_type, actor_operator_id, action, subject_type, subject_id, after)
      values ('operator', ${operator.id}, ${action}, 'camp', ${id}, ${tx.json({ reason })})`;
    const admins = await tx<{ email: string }[]>`
      select distinct p.email from person p
      join member_role r on r.person_id = p.id and r.role = 'admin'
      where p.active and p.email is not null`;
    return { ...c, adminEmails: admins.map((a) => a.email), reason };
  })) as { name: string; slug: string; adminEmails: string[]; reason: string };
}

export function statusEmail(
  to: "suspended" | "active",
  camp: { name: string; slug: string },
  domain: string,
  reason: string,
  product: string,
) {
  const site = `${camp.slug}.${domain}`;
  return to === "suspended"
    ? {
        subject: `${camp.name} is suspended on ${product}`,
        text: [
          `${camp.name}'s camp site (${site}) has been suspended by ${product}.`,
          "",
          `Reason: ${reason}`,
          "",
          "Members can still sign in and see everything, and Admins can still download the CSV exports, but nothing can be changed and the app sends no email except sign-in links. Nothing has been deleted.",
          "",
          "Reply to this email if you have questions.",
        ].join("\n"),
      }
    : {
        subject: `${camp.name} is restored on ${product}`,
        text: [
          `${camp.name}'s camp site (${site}) has been restored. Everything works as before.`,
          "",
          `Note from ${product}: ${reason}`,
        ].join("\n"),
      };
}

// The camp's running support grant, if any (R39), read as that camp.
export async function supportStatus(sql: postgres.Sql, id: string) {
  if (!ID_RE.test(id)) return null;
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.camp_id', ${id}, true)`;
    const [g] = await tx<{ expires_at: string }[]>`
      select expires_at::text from support_grant
      where revoked_at is null and expires_at > now()
      order by expires_at desc limit 1`;
    return g ? { until: g.expires_at } : null;
  })) as { until: string } | null;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Opens the camp under its running grant: a single-use token, good for 60 seconds, stored
// hashed on the grant (as that camp), for the browser to post to the camp's /support/enter.
export async function openSupport(
  sql: postgres.Sql,
  operator: Operator,
  id: string,
): Promise<{ slug: string; token: string }> {
  if (!ID_RE.test(id)) throw refuse("camp_not_found", 404);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  );
  return (await sql.begin(async (tx) => {
    const [c] = await tx<{ slug: string }[]>`select slug from camp where id = ${id}`;
    if (!c) throw refuse("camp_not_found", 404);
    await tx`select set_config('app.camp_id', ${id}, true)`;
    const [g] = await tx<{ id: string }[]>`
      update support_grant set token_hash = ${hash}, token_expires_at = now() + interval '60 seconds',
        token_used_at = null, opened_by_operator_id = ${operator.id}
      where id = (select id from support_grant where revoked_at is null and expires_at > now()
        order by expires_at desc limit 1)
      returning id`;
    if (!g) throw refuse("no_support_grant", 409);
    await log(tx, operator, "console_action", id, "support_opened", "");
    return { slug: c.slug, token };
  })) as { slug: string; token: string };
}

export async function recordDatabaseAccess(
  sql: postgres.Sql,
  operator: Operator,
  input: { campId: string; detail: string },
) {
  const detail = input.detail.trim();
  if (!detail) throw refuse("detail_needed");
  if (detail.length > 2000) throw refuse("detail_too_long");
  const campId = input.campId && ID_RE.test(input.campId) ? input.campId : null;
  await sql.begin(async (tx) => {
    await log(tx, operator, "database_access", campId, "database_access", detail);
  });
}

export async function operatorLog(sql: postgres.Sql, limit = 200) {
  return sql<
    {
      id: string;
      at: string;
      operator: string;
      kind: string;
      camp: string | null;
      action: string;
      detail: string;
    }[]
  >`
    select l.id, l.created_at::text as at, coalesce(o.name, 'Command line') as operator, l.kind,
      c.slug as camp, l.action, l.detail
    from operator_log l left join operator o on o.id = l.operator_id
    left join camp c on c.id = l.subject_camp_id
    -- What operators did, by hand or with a command (scripts/create-camp.ts); not the jobs.
    where l.operator_id is not null or l.kind = 'cli'
    order by l.created_at desc limit ${limit}`;
}

export const REASONS: Record<string, string> = {
  cap_range: "The daily limit must be a whole number from 0 to 10,000.",
  camp_not_found: "That camp doesn't exist.",
  reason_needed: "Give a reason. It's sent to the camp's Admins and kept in the logs.",
  reason_too_long: "Keep the reason under 1,000 characters.",
  not_active: "That camp isn't active, so it can't be suspended.",
  not_suspended: "That camp isn't suspended.",
  export_too_large:
    "This camp has too many files to export in one go. Export its data by hand (docs/operating.md: Data requests).",
  no_support_grant:
    "This camp hasn't granted support access, or it has ended. Its Admins grant it under Admin → Support access.",
  request_kind_needed: "Choose what was asked for.",
  request_email_needed: "Enter the requester's email address.",
  request_not_admin:
    "That email isn't an active Admin of this camp. Exports and camp deletions must be asked for by an Admin.",
  request_no_login: "No one in this camp signs in with that email.",
  request_not_found: "That request doesn't exist.",
  request_done: "That request has already been carried out.",
  request_not_confirmed: "The requester hasn't confirmed yet. Nothing can be done until they do.",
  camp_pending_deletion: "That camp is already marked for deletion.",
  not_pending_deletion: "That camp isn't marked for deletion.",
  camp_name_needed: "Enter the camp's name.",
  camp_name_too_long: "Keep the camp's name under 80 characters.",
  slug_format:
    "The address must be 2 to 40 lowercase letters, digits or single hyphens, starting and ending with a letter or digit.",
  slug_reserved: "That address is reserved. Choose another.",
  slug_taken: "Another camp already has that address.",
  admin_name_needed: "Enter each Admin's name.",
  admin_email_needed: "Enter each Admin's email address.",
  admin_email_twice: "Each Admin needs their own email address.",
  too_many_admins: "Up to 5 Admins to start with; more can be added in the camp.",
  signup_not_found: "That sign-up request doesn't exist (decided requests go after 90 days).",
  signup_decided: "That request has already been decided.",
  bad_size: "Choose the camp's size from the list.",
  note_too_long: "Keep the note under 1,000 characters.",
  year_range: "Choose the season the camp is planning: last year, this year, or the next two.",
  detail_needed: "Describe what you did and why.",
  detail_too_long: "Keep it under 2,000 characters.",
};

export function consoleError(e: unknown): { error: string } {
  const reason =
    e && typeof e === "object" && "data" in e
      ? ((e as { data?: { reason?: string } }).data?.reason ?? null)
      : null;
  if (reason && REASONS[reason]) return { error: REASONS[reason] };
  throw e;
}
