// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { data } from "react-router";
import { discordWebhook } from "../../../app/lib/instance-features";
import { notifyOperator, signupMessage } from "../../../app/lib/notify.server";
import { campInput, createCamp, defaultYear } from "./camps.server";
import type { Operator } from "./context.server";
import { sendPlatformMail } from "./mail.server";
import { CAMP_SIZES, type CampSize, SIGNUP_RETENTION_DAYS, type SignupAdmin } from "./signup";

// Issue #73: camps ask to join on the public sign-up page; the operator approves each request
// in the console (which creates the camp and invites its Admins, as "New camp" does) or
// declines it. These are organizers' contact details given to Theme Camp App directly, never a
// camp's data. A request is removed 90 days after it's decided.

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SignupInput = {
  campName: string;
  slug: string;
  admins: SignupAdmin[];
  seasonYear: string;
  campSize: string;
  note: string;
};

// The seasons a camp can sign up for: the one it's planning now, and the next.
export const signupYears = (now = new Date()) => [defaultYear(now), defaultYear(now) + 1];

async function slugTaken(sql: postgres.Sql, slug: string) {
  const [row] = await sql`select 1 from camp where slug = ${slug}`;
  return !!row;
}

// A camp's request from the public page. Checked like the console's "New camp", plus the
// address isn't already a camp's.
export async function submitSignup(sql: postgres.Sql, env: PlatformEnv, input: SignupInput) {
  const { name, slug, admins } = campInput(
    { name: input.campName, slug: input.slug, admins: input.admins },
    env,
  );
  const year = Number(input.seasonYear);
  if (!signupYears().includes(year)) throw refuse("year_range");
  const size = input.campSize ? (input.campSize as CampSize) : null;
  if (size && !CAMP_SIZES.includes(size)) throw refuse("bad_size");
  const note = input.note.trim() || null;
  if (note && note.length > 1000) throw refuse("note_too_long");
  if (await slugTaken(sql, slug)) throw refuse("slug_taken", 409);

  const [row] = await sql<{ id: string }[]>`
    insert into camp_signup (camp_name, slug, admins, season_year, camp_size, note)
    values (${name}, ${slug}, ${sql.json(admins)}, ${year}, ${size}, ${note})
    returning id`;
  // Issue #32: the operator's Discord, with the camp's name only.
  await notifyOperator(
    discordWebhook(env),
    signupMessage({
      name,
      organizers: admins.length,
      review: `https://ops.${env.PLATFORM_DOMAIN}/ops/signups`,
    }),
  );
  return row.id;
}

export type Signup = {
  id: string;
  campName: string;
  slug: string;
  admins: SignupAdmin[];
  seasonYear: number;
  campSize: CampSize | null;
  note: string | null;
  status: "pending" | "approved" | "declined";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  createdCampId: string | null;
  slugTaken: boolean; // another camp has the address now
};

const SELECT = (sql: postgres.Sql) => sql`
  select s.id, s.camp_name, s.slug, s.admins, s.season_year, s.camp_size, s.note, s.status,
    s.created_at, s.decided_at, o.name as decided_by, s.created_camp_id,
    exists (select 1 from camp c where c.slug = s.slug and c.id is distinct from s.created_camp_id)
      as slug_taken
  from camp_signup s left join operator o on o.id = s.decided_by_operator_id`;

const toSignup = (r: Record<string, unknown>): Signup => ({
  id: r.id as string,
  campName: r.camp_name as string,
  slug: r.slug as string,
  admins: r.admins as SignupAdmin[],
  seasonYear: Number(r.season_year),
  campSize: r.camp_size as CampSize | null,
  note: r.note as string | null,
  status: r.status as Signup["status"],
  createdAt: new Date(r.created_at as string).toISOString(),
  decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : null,
  decidedBy: r.decided_by as string | null,
  createdCampId: r.created_camp_id as string | null,
  slugTaken: r.slug_taken as boolean,
});

// Waiting requests, oldest first, then the ones decided in the last 90 days.
export async function listSignups(sql: postgres.Sql) {
  const rows = await sql`${SELECT(sql)}
    order by s.status <> 'pending', case when s.status = 'pending' then s.created_at end,
      s.decided_at desc nulls last
    limit 300`;
  return rows.map(toSignup);
}

export async function getSignup(sql: postgres.Sql, id: string) {
  if (!ID_RE.test(id)) return null;
  const [row] = await sql`${SELECT(sql)} where s.id = ${id}`;
  return row ? toSignup(row) : null;
}

export const pendingSignups = async (sql: postgres.Sql) =>
  Number((await sql`select count(*) as n from camp_signup where status = 'pending'`)[0].n);

// Marks a waiting request decided, or refuses: one decision per request, even with two
// operators pressing at once.
async function claim(sql: postgres.Sql, id: string, operator: Operator, status: string) {
  if (!ID_RE.test(id)) throw refuse("signup_not_found", 404);
  const [row] = await sql`
    update camp_signup set status = ${status}, decided_at = now(),
      decided_by_operator_id = ${operator.id}
    where id = ${id} and status = 'pending' returning id`;
  if (!row) {
    const exists = await getSignup(sql, id);
    throw refuse(exists ? "signup_decided" : "signup_not_found", exists ? 409 : 404);
  }
}

const logDecision = (
  sql: postgres.Sql,
  operator: Operator,
  action: string,
  detail: string,
  campId: string | null,
) =>
  sql`insert into operator_log (operator_id, kind, subject_camp_id, action, detail)
    values (${operator.id}, 'console_action', ${campId}, ${action}, ${detail})`;

// Approve: create the camp (the operator may have corrected its name, address or Admins) and
// invite its Admins. If creating fails (say the address was taken meanwhile), the request is
// waiting again and nothing else changed.
export async function approveSignup(
  sql: postgres.Sql,
  env: PlatformEnv,
  operator: Operator,
  id: string,
  edits: { name: string; slug: string; admins: SignupAdmin[]; year: string },
) {
  await claim(sql, id, operator, "approved");
  try {
    const created = await createCamp(sql, env, operator, edits);
    await sql`update camp_signup set created_camp_id = ${created.id} where id = ${id}`;
    await logDecision(
      sql,
      operator,
      "signup_approved",
      `${created.slug}: created from a sign-up request`,
      created.id,
    );
    return created;
  } catch (e) {
    await sql`
      update camp_signup set status = 'pending', decided_at = null, decided_by_operator_id = null
      where id = ${id}`;
    throw e;
  }
}

// Decline, optionally telling the organizers why (only if a message is written).
export async function declineSignup(
  sql: postgres.Sql,
  env: PlatformEnv,
  operator: Operator,
  id: string,
  message: string,
) {
  const text = message.trim();
  if (text.length > 2000) throw refuse("detail_too_long");
  await claim(sql, id, operator, "declined");
  const s = (await getSignup(sql, id)) as Signup;
  await logDecision(
    sql,
    operator,
    "signup_declined",
    `${s.slug}: ${text ? "declined, organizers emailed" : "declined"}`,
    null,
  );
  if (!text) return { emailed: 0 };
  const emailed = await sendPlatformMail(
    env,
    sql,
    s.admins.map((a) => a.email),
    `Your ${env.PRODUCT_NAME} request for ${s.campName}`,
    [
      `Hi,`,
      "",
      `Thanks for asking to bring ${s.campName} to ${env.PRODUCT_NAME}.`,
      "",
      text,
      "",
      env.PRODUCT_NAME,
    ].join("\n"),
  );
  return { emailed };
}

// Hourly: decided requests are kept for 90 days.
export async function expireSignups(sql: postgres.Sql) {
  await sql`
    delete from camp_signup
    where status <> 'pending'
      and decided_at < now() - make_interval(days => ${SIGNUP_RETENTION_DAYS})`;
}
