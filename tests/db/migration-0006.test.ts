// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0006 adds the feature switches. Camps that existed before it keep every feature
// on; camps created after it get the defaults (SAPs and volunteer roles off; it also switched
// the old positions feature, dropped in 0033). The
// other tests only ever see a fully migrated, freshly seeded database, so this one stops at
// 0005, adds a camp, then applies the rest.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const name = `t_${randomUUID().replaceAll("-", "")}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;
let upTo0005: string;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  upTo0005 = mkdtempSync(join(tmpdir(), "tca-migrations-"));
  cpSync(MIGRATIONS, upTo0005, { recursive: true });
  const journalPath = join(upTo0005, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 5);
  writeFileSync(journalPath, JSON.stringify(journal));
});
afterAll(async () => {
  rmSync(upTo0005, { recursive: true, force: true });
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
});

async function addCamp(sql: ReturnType<typeof postgres>, slug: string) {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into camp (slug, name) values (${slug}, ${slug}) returning id`;
  await sql`insert into burn (camp_id, year) values (${id}, 2027)`;
  await sql`insert into camp_settings (camp_id, current_year) values (${id}, 2027)`;
  return id;
}

describe("migration 0006", () => {
  it("keeps every feature on for existing camps, and gives new camps the defaults", async () => {
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: upTo0005 });
      const existing = await addCamp(sql, "existing");
      await migrate(drizzle({ client: sql }), { migrationsFolder: MIGRATIONS });
      const added = await addCamp(sql, "added");

      const rows = await sql<
        { camp_id: string; saps: boolean; volunteer: boolean; dues: boolean }[]
      >`
        select camp_id, feature_saps as saps, feature_volunteer as volunteer, feature_dues as dues
        from camp_settings`;
      const by = Object.fromEntries(rows.map((r) => [r.camp_id, r]));
      expect(by[existing]).toMatchObject({
        saps: true,
        volunteer: true,
        dues: true,
      });
      expect(by[added]).toMatchObject({
        saps: false,
        volunteer: false,
        dues: true,
      });
    } finally {
      await sql.end();
    }
  });
});
