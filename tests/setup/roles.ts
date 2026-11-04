// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";

// The database roles are cluster-wide, so create them once per run (as the test superuser), the
// way scripts/db-roles.ts does in Neon. Request tests connect as app_runtime from U3; tests that
// check row-level security connect as it now.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test";

export const ROLE_PASSWORD = "test";

export default async function setup() {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    for (const [role, attrs] of [
      ["app_runtime", `login nobypassrls password '${ROLE_PASSWORD}'`],
      ["app_platform", `login nobypassrls password '${ROLE_PASSWORD}'`],
      ["app_probe", `login nobypassrls password '${ROLE_PASSWORD}'`],
      ["app_definer", "nologin bypassrls"],
    ] as const) {
      // Parallel test runs may race to create the same role.
      await sql.unsafe(`
        do $$ begin
          create role ${role};
        exception when duplicate_object or unique_violation then null;
        end $$`);
      await sql.unsafe(`alter role ${role} with ${attrs}`);
    }
  } finally {
    await sql.end();
  }
}
