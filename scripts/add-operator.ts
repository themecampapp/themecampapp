// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adds (or reactivates) a platform operator: someone who may use the operator console, once
// Cloudflare Access has let them through with MFA (R41). Uses the owner DATABASE_URL.
//   DATABASE_URL=… npx tsx scripts/add-operator.ts --email you@example.com --name "Your Name"
//   DATABASE_URL=… npx tsx scripts/add-operator.ts --email you@example.com --deactivate
// The email must be the one your Access identity provider asserts.
import { parseArgs } from "node:util";
import postgres from "postgres";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    deactivate: { type: "boolean", default: false },
  },
});
const email = values.email?.trim().toLowerCase();
if (!email?.includes("@") || !process.env.DATABASE_URL) {
  console.error(
    'Usage: DATABASE_URL=… tsx scripts/add-operator.ts --email … --name "…" [--deactivate]',
  );
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  if (values.deactivate) {
    const rows = await sql`update operator set active = false where email = ${email} returning id`;
    console.log(rows.length ? `Deactivated ${email}.` : `No operator with ${email}.`);
  } else {
    if (!values.name?.trim()) throw new Error("--name is required when adding an operator");
    await sql`
      insert into operator (email, name) values (${email}, ${values.name.trim()})
      on conflict (email) do update set name = excluded.name, active = true`;
    console.log(`${email} is an active operator.`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
