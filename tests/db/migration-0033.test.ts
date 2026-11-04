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

// Issue #115: migration 0033 drops the old position tables (copied into jobs by 0031) and
// camp_settings.feature_positions, but refuses if anything wrote to them after 0031 reached
// production on 2026-10-11. This test stops at 0032, adds old rows, and applies 0033.
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const name = `t_${randomUUID().replaceAll("-", "")}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;
let upTo0032: string;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  upTo0032 = mkdtempSync(join(tmpdir(), "tca-migrations-"));
  cpSync(MIGRATIONS, upTo0032, { recursive: true });
  const journalPath = join(upTo0032, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 32);
  writeFileSync(journalPath, JSON.stringify(journal));
});
afterAll(async () => {
  rmSync(upTo0032, { recursive: true, force: true });
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
});

const tables = (sql: ReturnType<typeof postgres>) =>
  sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('camp_position', 'position_holder')
    order by 1`.then((rows) => rows.map((r) => r.table_name));

const column = (sql: ReturnType<typeof postgres>) =>
  sql`select 1 from information_schema.columns
    where table_name = 'camp_settings' and column_name = 'feature_positions'`.then(
    (rows) => rows.length,
  );

describe("migration 0033", () => {
  it("refuses while the old tables have rows newer than 0031, then drops them", async () => {
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: upTo0032 });
      const [{ id: campId }] = await sql<{ id: string }[]>`
        insert into camp (slug, name) values ('old', 'Old') returning id`;
      const [season] = await sql<{ id: string }[]>`
        insert into burn (camp_id, year) values (${campId}, 2026) returning id`;
      await sql`insert into camp_settings (camp_id, current_year, feature_positions)
        values (${campId}, 2026, true)`;
      const [ann] = await sql<{ id: string }[]>`
        insert into person (camp_id, legal_name, email) values (${campId}, 'Ann', 'ann@example.com')
        returning id`;
      // Written before 0031 reached production.
      const [lead] = await sql<{ id: string }[]>`
        insert into camp_position (camp_id, title, sort, created_at)
        values (${campId}, 'Main camp lead', 10, '2026-09-01') returning id`;
      // Written after: something still used the old tables, so 0033 must stop.
      const [holder] = await sql<{ id: string }[]>`
        insert into position_holder (camp_id, burn_id, position_id, person_id, created_at)
        values (${campId}, ${season.id}, ${lead.id}, ${ann.id}, '2026-10-20') returning id`;

      await expect(
        migrate(drizzle({ client: sql }), { migrationsFolder: MIGRATIONS }),
      ).rejects.toThrow();
      // Nothing changed: the refusal rolls the migration back.
      expect(await tables(sql)).toEqual(["camp_position", "position_holder"]);
      expect(await column(sql)).toBe(1);

      await sql`update position_holder set created_at = '2026-09-01' where id = ${holder.id}`;
      await migrate(drizzle({ client: sql }), { migrationsFolder: MIGRATIONS });
      expect(await tables(sql)).toEqual([]);
      expect(await column(sql)).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
