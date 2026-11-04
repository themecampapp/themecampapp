// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// One-time per camp: make the camp's first Lead + Treasurer. Uses the owner DATABASE_URL.
//   DATABASE_URL=… npx tsx scripts/bootstrap-lead.ts --camp <slug> --name "Ada Lovelace" --email you@example.com [--playa "Name"]
import { parseArgs } from "node:util";
import { bootstrapFirstLead } from "~/lib/bootstrap.server";
import { createClient, createDb } from "~/lib/db.server";
import { lookupCamp } from "~/lib/tenancy.server";

const { values } = parseArgs({
  options: {
    camp: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    playa: { type: "string" },
  },
});
if (!values.camp || !values.name || !values.email || !process.env.DATABASE_URL) {
  console.error(
    "Usage: DATABASE_URL=… tsx scripts/bootstrap-lead.ts --camp <slug> --name … --email … [--playa …]",
  );
  process.exit(1);
}

const lookup = createClient(process.env.DATABASE_URL, 1);
const camp = await lookupCamp(lookup, values.camp);
await lookup.end();
if (!camp) {
  console.error(`No camp with the slug "${values.camp}".`);
  process.exit(1);
}
const { db, close } = createDb(process.env.DATABASE_URL, camp.id);
try {
  const p = await bootstrapFirstLead(db, {
    legalName: values.name,
    email: values.email,
    playaName: values.playa,
  });
  console.log(
    `Created Lead + Treasurer ${p.legalName} for ${camp.slug}. They sign in at the camp's address.`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await close();
}
