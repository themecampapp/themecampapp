// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { data } from "react-router";
import { campOrigin } from "../../../app/lib/hosts";
import { discordWebhook } from "../../../app/lib/instance-features";
import { campCreatedMessage, notifyOperator } from "../../../app/lib/notify.server";
import { instanceReserved, slugProblem } from "../../../app/lib/reserved-slugs";
import type { Operator } from "./context.server";
import { sendPlatformMail } from "./mail.server";
import { MAX_ADMINS } from "./signup";

// R12: during the pilot the operator creates each camp in the console. One transaction makes
// the camp, its first season and settings (features at R20's defaults), and its first person
// (Admin, Lead and Treasurer) with a pending invite; then that person is emailed. They accept
// the pilot agreement on first sign-in (R68), and the setup checklist takes it from there (R24).

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The season a camp created today plans for: Burning Man ends in early September, so from
// September on it's next year's.
export function defaultYear(now = new Date()) {
  return now.getUTCMonth() >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export type NewCamp = {
  name: string;
  slug: string;
  // The camp's first Admins (Admin, Lead and Treasurer each), the first one first. The
  // console's form gives one; an approved sign-up up to five (issue #73).
  admins: Array<{ name: string; email: string }>;
  year: string;
};

export type Created = {
  id: string;
  slug: string;
  name: string;
  // The camp's own origin (campOrigin: <slug>.<domain>, or a single-camp instance's host).
  site: string;
  emails: string[];
  invited: number;
};

// A new camp's details, tidied, or the reason they can't be used. Shared with the sign-up page.
export function campInput(input: Omit<NewCamp, "year">, env: PlatformEnv) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw refuse("camp_name_needed");
  if (name.length > 80) throw refuse("camp_name_too_long");
  const slug = input.slug.trim().toLowerCase();
  const problem = slugProblem(slug, instanceReserved(env));
  if (problem) throw refuse(problem);
  const admins = input.admins
    .map((a) => ({ name: a.name.trim().replace(/\s+/g, " "), email: a.email.trim().toLowerCase() }))
    .filter((a) => a.name || a.email);
  if (admins.length === 0) throw refuse("admin_email_needed");
  if (admins.length > MAX_ADMINS) throw refuse("too_many_admins");
  for (const a of admins) {
    if (!a.name || a.name.length > 80) throw refuse("admin_name_needed");
    if (!EMAIL_RE.test(a.email) || a.email.length > 254) throw refuse("admin_email_needed");
  }
  if (new Set(admins.map((a) => a.email)).size !== admins.length) throw refuse("admin_email_twice");
  return { name, slug, admins };
}

// Who's creating it: an operator in the console, or "cli" for scripts/create-camp.ts on an
// instance without one (open-source plan 3.3).
export async function createCamp(
  sql: postgres.Sql,
  env: PlatformEnv,
  by: Operator | "cli",
  input: NewCamp,
): Promise<Created> {
  const operatorId = by === "cli" ? null : by.id;
  const { name, slug, admins } = campInput(input, env);
  const year = Number(input.year);
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < thisYear - 1 || year > thisYear + 2) {
    throw refuse("year_range");
  }
  const emails = admins.map((a) => a.email);

  const id = (await sql
    .begin(async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into camp (slug, name, created_in_console) values (${slug}, ${name}, true)
        returning id`;
      await tx`select set_config('app.camp_id', ${c.id}, true)`;
      await tx`insert into burn (year) values (${year})`;
      await tx`insert into camp_settings (current_year) values (${year})`;
      for (const a of admins) {
        const [p] = await tx<{ id: string }[]>`
          insert into person (legal_name, email) values (${a.name}, ${a.email}) returning id`;
        await tx`
          insert into member_role (person_id, role)
          values (${p.id}, 'admin'), (${p.id}, 'lead'), (${p.id}, 'treasurer')`;
        await tx`
          insert into invite (person_id, email, status, sent_at)
          values (${p.id}, ${a.email}, 'pending', now())`;
      }
      await tx`
        insert into audit_log (actor_type, actor_operator_id, action, subject_type, subject_id, after)
        values (${operatorId ? "operator" : "system"}, ${operatorId}, 'camp_created', 'camp', ${c.id},
          ${tx.json({ slug, name, year, firstAdmins: emails, roles: ["admin", "lead", "treasurer"] })})`;
      await tx`
        insert into operator_log (operator_id, kind, subject_camp_id, action, detail)
        values (${operatorId}, ${operatorId ? "console_action" : "cli"}, ${c.id}, 'camp_created',
          ${`${slug}: first Admin${admins.length > 1 ? "s" : ""} ${admins.map((a) => a.name).join(", ")}, season ${year}`})`;
      return c.id;
    })
    .catch((e) => {
      if ((e as { code?: string }).code === "23505") throw refuse("slug_taken", 409);
      throw e;
    })) as string;

  const site = campOrigin(slug, env.PLATFORM_DOMAIN, env);
  let invited = 0;
  for (const a of admins) {
    const others = admins.filter((o) => o !== a).map((o) => o.name);
    invited += await sendPlatformMail(
      env,
      sql,
      [a.email],
      `You're invited to set up ${name} on ${env.PRODUCT_NAME}`,
      [
        `Hi ${a.name},`,
        "",
        `${name} now has its own camp app at ${site}, and you're ${others.length ? `one of its first Admins, with ${others.join(", ")}` : "its first Admin"}.`,
        "",
        "Sign in here with this email address:",
        `${site}/sign-in?email=${encodeURIComponent(a.email)}`,
        "",
        `${env.PILOT_AGREEMENT === "true" ? "The first time, you'll be asked to read and accept the pilot agreement. Then a" : "A"} short checklist walks you through setting up the camp: its settings, features, dues, key dates, guides, and your people.`,
        ...(env.SUPPORT_URL
          ? ["", `Questions, problems or ideas? Join us on Discord: ${env.SUPPORT_URL}`]
          : ["", `Questions, problems or ideas? Write to ${env.CONTACT_EMAIL}.`]),
      ].join("\n"),
    );
  }
  // Issue #32: the operator's Discord hears of every new camp (here, so self-service sign-ups
  // will too). Waits at most 5 seconds and never fails the creation.
  await notifyOperator(discordWebhook(env), campCreatedMessage({ name, site, year }));
  return { id, slug, name, site, emails, invited };
}

// What the console says after creating a camp.
export function createdNotice(c: Created) {
  const site = new URL(c.site).host;
  const who = c.emails.join(", ");
  return c.invited === c.emails.length
    ? `Created. ${who} ${c.emails.length > 1 ? "are" : "is"} invited to sign in at ${site}.`
    : `Created, but ${c.emails.length - c.invited} of the invite emails (to ${who}) weren't sent (see the Worker's logs; on staging, is the address on MAIL_ALLOWLIST?). They can still sign in at ${site}.`;
}
