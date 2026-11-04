// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceGrants } from "../../scripts/db-grants";

// The other tests migrate as the container's superuser, which skips permission checks that
// Neon enforces (a migration once passed here and failed on staging: a new function owner needs
// CREATE on the schema). This runs every migration as a role set up like Neon's neondb_owner:
// not a superuser, CREATEROLE, CREATEDB, BYPASSRLS, owning its database, and able to SET ROLE
// app_definer without inheriting it (as scripts/db-roles.ts grants).
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const suffix = randomBytes(4).toString("hex");
const role = `t_neon_owner_${suffix}`;
const database = `t_neon_${suffix}`;
const password = "owner-password";
let admin: ReturnType<typeof postgres>;

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(
    `create role ${role} login nosuperuser createrole createdb bypassrls password '${password}'`,
  );
  await admin.unsafe(`grant app_definer to ${role} with set true, inherit false`);
  await admin.unsafe(`create database ${database} owner ${role}`);
});
afterAll(async () => {
  await admin.unsafe(`drop database if exists ${database} with (force)`);
  await admin.unsafe(`drop role if exists ${role}`);
  await admin.end();
});

describe("migrations as a Neon-like owner", () => {
  it("apply, and the grants check passes", async () => {
    const url = new URL(ADMIN_URL);
    url.username = role;
    url.password = password;
    url.pathname = `/${database}`;
    const owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const [who] = await owner`select rolsuper from pg_roles where rolname = current_user`;
      expect(who.rolsuper).toBe(false);
      await migrate(drizzle({ client: owner }), { migrationsFolder: MIGRATIONS });
      expect(await enforceGrants(owner)).toBe("enforced");
      const [definer] = await owner`
        select has_schema_privilege('app_definer', 'public', 'create') as can_create`;
      expect(definer.can_create).toBe(false);
    } finally {
      await owner.end();
    }
  });
});
