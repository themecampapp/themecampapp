// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Creates a camp without the console (open-source plan 3.3): the same createCamp() the console
// uses, so the camp, its first season, its first Admins and their invite emails come out the
// same. The operator log and the camp's audit log record it as done from the command line.
//   DATABASE_URL=<owner> EMAIL_API_KEY=… npm run camp:create -- --instance <name> \
//     --name "Dusty Owls" --slug dustyowls --admin "Olive Owl <owl@example.com>" [--admin …] \
//     [--year 2027]
// --instance names config/<name>.json: its domain, product name, email provider and reserved
// addresses. Without EMAIL_API_KEY the camp is still created, and the Admins aren't emailed
// (they can still sign in at the camp's address). MAIL_ALLOWLIST and DISCORD_WEBHOOK_URL apply
// as on the Worker when set.
import { parseArgs } from "node:util";
import postgres from "postgres";
import { createCamp, createdNotice, defaultYear } from "../platform/app/lib/camps.server";
import { REASONS } from "../platform/app/lib/console.server";
import { platformVars, readConfig } from "./config-to-wrangler";

const USAGE =
  'Usage: DATABASE_URL=… npm run camp:create -- --instance <name> --name "…" --slug … --admin "Name <email>" [--admin …] [--year …]';

// "Olive Owl <owl@example.com>"
export function parseAdmin(value: string) {
  const m = value.match(/^\s*(.*?)\s*<([^<>\s]+)>\s*$/);
  return m ? { name: m[1], email: m[2] } : { name: "", email: value.trim() };
}

async function main() {
  const { values } = parseArgs({
    options: {
      instance: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      admin: { type: "string", multiple: true },
      year: { type: "string" },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url || !values.instance || !values.name || !values.slug || !values.admin?.length) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const env = {
    ...platformVars(readConfig(values.instance)),
    EMAIL_API_KEY: process.env.EMAIL_API_KEY,
    MAIL_ALLOWLIST: process.env.MAIL_ALLOWLIST,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  } as unknown as PlatformEnv;
  if (!env.EMAIL_API_KEY) console.warn("No EMAIL_API_KEY: the Admins won't be emailed.");

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const created = await createCamp(sql, env, "cli", {
      name: values.name,
      slug: values.slug,
      admins: values.admin.map(parseAdmin),
      year: values.year ?? String(defaultYear()),
    });
    console.log(createdNotice(created));
  } catch (e) {
    const reason =
      e && typeof e === "object" && "data" in e
        ? (e as { data?: { reason?: string } }).data?.reason
        : undefined;
    console.error(reason ? (REASONS[reason] ?? reason) : e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith("create-camp.ts")) await main();
