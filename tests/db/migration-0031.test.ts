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

// Issue #106: migration 0031 turns elected positions into jobs that Leads fill, keeping their
// ids and their holders, and gives a camp that had positions switched on the jobs feature. The
// other tests only see a freshly seeded database, so this one stops at 0030, adds a camp with
// positions the old way, then applies 0031 and 0032. (0033 drops the old tables, and refuses
// rows as new as these: migration-0033.test.ts.)
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const name = `t_${randomUUID().replaceAll("-", "")}`;
const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;
let upTo0030: string;
let upTo0032: string;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  upTo0030 = migrationsUpTo(30);
  upTo0032 = migrationsUpTo(32);
});

function migrationsUpTo(last: number) {
  const dir = mkdtempSync(join(tmpdir(), "tca-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= last);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}
afterAll(async () => {
  for (const dir of [upTo0030, upTo0032]) rmSync(dir, { recursive: true, force: true });
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
});

describe("migration 0031", () => {
  it("moves positions and their holders into jobs, and switches jobs on", async () => {
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: upTo0030 });
      const [{ id: campId }] = await sql<{ id: string }[]>`
        insert into camp (slug, name) values ('old', 'Old') returning id`;
      const [y26, y27] = await sql<{ id: string }[]>`
        insert into burn (camp_id, year) values (${campId}, 2026), (${campId}, 2027) returning id`;
      await sql`insert into camp_settings (camp_id, current_year, feature_positions, feature_volunteer)
        values (${campId}, 2027, true, false)`;
      const people = await sql<{ id: string }[]>`
        insert into person (camp_id, legal_name, email) values
          (${campId}, 'Ann', 'ann@example.com'), (${campId}, 'Bo', 'bo@example.com'),
          (${campId}, 'Cy', 'cy@example.com')
        returning id`;
      const [lead, treasurer] = await sql<{ id: string }[]>`
        insert into camp_position (camp_id, title, sort) values
          (${campId}, 'Main camp lead', 10), (${campId}, 'Treasurer', 20)
        returning id`;
      // Two co-leads in 2027, one in 2026; nobody holds Treasurer.
      const holders = await sql<{ id: string }[]>`
        insert into position_holder (camp_id, burn_id, position_id, person_id, assigned_by_person_id) values
          (${campId}, ${y27.id}, ${lead.id}, ${people[0].id}, ${people[2].id}),
          (${campId}, ${y27.id}, ${lead.id}, ${people[1].id}, ${people[2].id}),
          (${campId}, ${y26.id}, ${lead.id}, ${people[0].id}, null)
        returning id`;
      const [kitchen] = await sql<{ id: string }[]>`
        insert into volunteer_role (camp_id, title, slots, sort) values (${campId}, 'Kitchen', 3, 10)
        returning id`;
      // A second camp: its position stays its own, under its own camp.
      const [{ id: otherCamp }] = await sql<{ id: string }[]>`
        insert into camp (slug, name) values ('other', 'Other') returning id`;
      await sql`insert into burn (camp_id, year) values (${otherCamp}, 2027)`;
      await sql`insert into camp_settings (camp_id, current_year, feature_positions, feature_volunteer)
        values (${otherCamp}, 2027, true, true)`;
      const [chair] = await sql<{ id: string }[]>`
        insert into camp_position (camp_id, title, sort) values (${otherCamp}, 'Chair', 10)
        returning id`;

      await migrate(drizzle({ client: sql }), { migrationsFolder: upTo0032 });

      const jobs = await sql<
        {
          id: string;
          title: string;
          slots: number;
          self_signup: boolean;
          show_in_yearbook: boolean;
          sort: number;
        }[]
      >`select id, title, slots, self_signup, show_in_yearbook, sort from volunteer_role
        where camp_id = ${campId} order by sort, title`;
      expect(jobs.map((j) => j.title)).toEqual(["Main camp lead", "Treasurer", "Kitchen"]);
      expect(jobs[0]).toMatchObject({
        id: lead.id,
        slots: 2,
        self_signup: false,
        show_in_yearbook: true,
      });
      expect(jobs[1]).toMatchObject({ id: treasurer.id, slots: 1, self_signup: false });
      expect(jobs[2]).toMatchObject({
        id: kitchen.id,
        self_signup: true,
        show_in_yearbook: false,
      });

      const signups = await sql<
        { id: string; burn_id: string; person_id: string; added_by_person_id: string | null }[]
      >`select id, burn_id, person_id, added_by_person_id from volunteer_signup
        where role_id = ${lead.id} order by created_at, id`;
      expect(signups.map((s) => s.id).sort()).toEqual(holders.map((h) => h.id).sort());
      expect(signups.filter((s) => s.burn_id === y27.id)).toHaveLength(2);
      expect(signups.find((s) => s.burn_id === y27.id)?.added_by_person_id).toBe(people[2].id);

      const theirs = await sql<{ id: string; camp_id: string; title: string }[]>`
        select id, camp_id, title from volunteer_role where camp_id = ${otherCamp}`;
      expect(theirs).toEqual([{ id: chair.id, camp_id: otherCamp, title: "Chair" }]);

      const [settings] = await sql<{ feature_volunteer: boolean }[]>`
        select feature_volunteer from camp_settings where camp_id = ${campId}`;
      expect(settings.feature_volunteer).toBe(true);
    } finally {
      await sql.end();
    }
  });
});
