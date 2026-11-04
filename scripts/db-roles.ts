// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";

// Creates the Workers' login roles with SQL (never the Neon console: console-made roles join
// neon_superuser, which bypasses row-level security) and sets their passwords.
//   DATABASE_URL           owner connection (direct, not pooled)
//   APP_RUNTIME_PASSWORD   camp Worker role (Hyperdrive HYPERDRIVE); optional once it exists
//   APP_PLATFORM_PASSWORD  platform Worker role (Hyperdrive HYPERDRIVE_PLATFORM); likewise
//   APP_PROBE_PASSWORD     the daily isolation probe's read-only role (GitHub Actions
//                          PROBE_DATABASE_URL); optional: created only when given
// Also creates app_definer (NOLOGIN, BYPASSRLS), which owns the SECURITY DEFINER functions, and
// lets the owner assign functions to it (SET, not INHERIT: the owner never acts as it).
// Re-running is safe: missing roles are created; a password is reset only when given.
// Grants are applied and checked by scripts/db-grants.ts on every deploy.

const ROLES = [
  { name: "app_runtime", env: "APP_RUNTIME_PASSWORD", optional: false },
  { name: "app_platform", env: "APP_PLATFORM_PASSWORD", optional: false },
  { name: "app_probe", env: "APP_PROBE_PASSWORD", optional: true },
] as const;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  for (const role of ROLES) {
    const password = process.env[role.env];
    const [exists] = await sql`select 1 from pg_roles where rolname = ${role.name}`;
    if (password !== undefined && !/^[A-Za-z0-9]{32,}$/.test(password)) {
      throw new Error(`${role.env} must be at least 32 letters or digits`);
    }
    if (!exists && password === undefined && role.optional) continue;
    if (!exists && password === undefined) {
      throw new Error(`${role.name} doesn't exist yet: set ${role.env} to create it`);
    }
    if (!exists) await sql.unsafe(`create role ${role.name} login nobypassrls`);
    // Without a password the role keeps its current one (Hyperdrive stays connected).
    // The password is validated as alphanumeric above, so it is safe to inline.
    await sql.unsafe(
      password === undefined
        ? `alter role ${role.name} with login nobypassrls`
        : `alter role ${role.name} with login nobypassrls password '${password}'`,
    );
    const [r] = await sql`
      select rolbypassrls, rolsuper,
        case when exists (select 1 from pg_roles where rolname = 'neon_superuser')
          then pg_has_role(${role.name}, 'neon_superuser', 'member') else false end as neon_super
      from pg_roles where rolname = ${role.name}`;
    if (r.rolbypassrls || r.rolsuper || r.neon_super) {
      throw new Error(`${role.name} must not bypass row-level security`);
    }
    console.log(`${role.name}: ready`);
  }
  const [definer] = await sql`select 1 from pg_roles where rolname = 'app_definer'`;
  if (!definer) await sql.unsafe("create role app_definer nologin bypassrls");
  await sql.unsafe("alter role app_definer with nologin bypassrls");
  await sql.unsafe("grant app_definer to current_user with set true, inherit false");
  console.log("app_definer: ready");
} finally {
  await sql.end();
}
