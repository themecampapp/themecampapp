// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { inArray, lt, sql } from "drizzle-orm";
import { verification } from "~/db/auth-schema";
import { authEvent } from "~/db/schema";
import type { AuthEventName } from "./auth-events";
import type { Db } from "./db.server";

const RETENTION_DAYS = 90;

// Never throws: a logging problem must not break signing in.
export async function logAuthEvent(
  db: Db,
  e: {
    event: AuthEventName;
    email?: string | null;
    personId?: string | null;
    request?: Request;
    detail?: Record<string, unknown>;
  },
) {
  const row = {
    event: e.event,
    email: e.email ?? null,
    personId: e.personId ?? null,
    ip: e.request?.headers.get("cf-connecting-ip") ?? null,
    userAgent: e.request?.headers.get("user-agent")?.slice(0, 400) ?? null,
    detail: e.detail ?? null,
  };
  // Also to the Worker's logs (Cloudflare dashboard), without the email.
  console.log(JSON.stringify({ auth: e.event, ...e.detail }));
  try {
    await db.insert(authEvent).values(row);
    if (e.event === "link_requested") {
      await db
        .delete(authEvent)
        .where(lt(authEvent.createdAt, sql`now() - make_interval(days => ${RETENTION_DAYS})`));
    }
  } catch (err) {
    console.error(`auth_event insert failed: ${err instanceof Error ? err.message : err}`);
  }
}

// What an emailed token points at, read without using it up (Better Auth stores it hashed).
export async function peekMagicToken(
  db: Db,
  token: string,
): Promise<{ email: string | null; state: "valid" | "expired" | "used_or_unknown" }> {
  try {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hashed = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // Better Auth 1.7.7 stores it as "magic-link:<hash>"; earlier versions stored the bare hash,
    // which links sent just before an upgrade still have.
    const [v] = await db
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(inArray(verification.identifier, [`magic-link:${hashed}`, hashed]))
      .limit(1);
    if (!v) return { email: null, state: "used_or_unknown" };
    const email = (JSON.parse(v.value) as { email?: string }).email ?? null;
    return { email, state: v.expiresAt < new Date() ? "expired" : "valid" };
  } catch {
    return { email: null, state: "used_or_unknown" };
  }
}

export type AuthEventRow = {
  id: string;
  at: string;
  event: string;
  email: string | null;
  personId: string | null;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown> | null;
};

// Newest first. A row's person is the one it names, or else whoever has that email.
export async function listAuthEvents(
  db: Db,
  opts: { q?: string; event?: string; before?: string; limit?: number },
): Promise<AuthEventRow[]> {
  const q = opts.q?.trim() || null;
  const rows = await db.execute<{
    id: string;
    at: string;
    event: string;
    email: string | null;
    person_id: string | null;
    name: string | null;
    ip: string | null;
    user_agent: string | null;
    detail: Record<string, unknown> | null;
  }>(sql`
    select e.id, to_json(e.created_at) #>> '{}' as at, e.event, e.email, p.id as person_id,
      coalesce(p.playa_name, p.legal_name) as name, e.ip, e.user_agent, e.detail
    from auth_event e
    left join lateral (
      select id, playa_name, legal_name from person
      where id = e.person_id or (e.person_id is null and lower(email) = lower(e.email))
      order by active desc limit 1
    ) p on true
    where (${opts.event ?? null}::text is null or e.event = ${opts.event ?? null})
      and (${opts.before ?? null}::timestamptz is null or e.created_at < ${opts.before ?? null}::timestamptz)
      and (${q}::text is null or e.email ilike ${`%${q ?? ""}%`}
        or p.playa_name ilike ${`%${q ?? ""}%`} or p.legal_name ilike ${`%${q ?? ""}%`})
    order by e.created_at desc
    limit ${opts.limit ?? 100}
  `);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    event: r.event,
    email: r.email,
    personId: r.person_id,
    name: r.name,
    ip: r.ip,
    userAgent: r.user_agent,
    detail: typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail,
  }));
}

// Everyone who asked for a link in the last week and hasn't signed in since their last ask.
export async function stuckSignIns(db: Db) {
  const rows = await db.execute<{
    email: string;
    requests: number;
    last_request: string;
    last_event: string;
    name: string | null;
    person_id: string | null;
  }>(sql`
    with asks as (
      select lower(email) as email, count(*)::int as requests, max(created_at) as last_request
      from auth_event
      where event = 'link_requested' and created_at > now() - interval '7 days'
      group by 1
    )
    select a.email, a.requests, to_json(a.last_request) #>> '{}' as last_request,
      (select e.event from auth_event e where lower(e.email) = a.email
        order by e.created_at desc limit 1) as last_event,
      (select coalesce(p.playa_name, p.legal_name) from person p
        where lower(p.email) = a.email order by p.active desc limit 1) as name,
      (select p.id from person p where lower(p.email) = a.email order by p.active desc limit 1)
        as person_id
    from asks a
    where not exists (
      select 1 from auth_event e
      where lower(e.email) = a.email and e.event = 'signed_in' and e.created_at > a.last_request
    )
    order by a.last_request desc
  `);
  return rows.map((r) => ({
    email: r.email,
    requests: Number(r.requests),
    lastRequest: r.last_request,
    lastEvent: r.last_event,
    name: r.name,
    personId: r.person_id,
  }));
}
