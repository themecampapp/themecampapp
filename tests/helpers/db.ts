// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as authSchema from "~/db/auth-schema";
import * as appSchema from "~/db/schema";
import { enforceGrants } from "../../scripts/db-grants";
import { ROLE_PASSWORD } from "../setup/roles";
import { seedDefaultCamp, TEST_CAMP_ID } from "./seed";

const schema = { ...appSchema, ...authSchema };

// Tests run against a real Postgres (docker locally, a service container in CI).
// Each test file gets its own throwaway database with all migrations applied.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function createTestDb() {
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  // Migrate and grant as the owner, with no camp set.
  const owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await migrate(drizzle({ client: owner, schema }), { migrationsFolder: MIGRATIONS });
  await enforceGrants(owner);
  await owner.end();
  // Fixtures run as the test superuser (which skips row-level security) acting for the default
  // camp, set for the whole connection. Only tests do that: the app sets it per transaction.
  const client = postgres(url.toString(), {
    max: 3,
    onnotice: () => {},
    connection: { "app.camp_id": TEST_CAMP_ID },
  });
  const db = drizzle({ client, schema });
  const defaultCamp = await seedDefaultCamp(db);

  // What the Workers use: the app's own role, which can't skip row-level security.
  const runtimeUrl = new URL(url);
  runtimeUrl.username = "app_runtime";
  runtimeUrl.password = ROLE_PASSWORD;

  return {
    db,
    client,
    url: url.toString(),
    runtimeUrl: runtimeUrl.toString(),
    campId: defaultCamp.id,
    async drop() {
      await client.end();
      const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
