// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "~/db/auth-schema";
import { burn, participation, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

async function makePerson(overrides: Partial<typeof person.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(person)
    .values({ legalName: "Test Person", ...overrides })
    .returning();
  return row;
}

describe("schema", () => {
  it("seeds the 2024 to 2027 seasons", async () => {
    const years = (await t.db.select({ year: burn.year }).from(burn)).map((b) => b.year).sort();
    expect(years).toEqual([2024, 2025, 2026, 2027]);
  });

  it("allows only one participation per person per season", async () => {
    const p = await makePerson();
    const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await t.db.insert(participation).values({ personId: p.id, burnId: season.id });
    await expect(
      t.db.insert(participation).values({ personId: p.id, burnId: season.id }),
    ).rejects.toThrow();
  });

  it("rejects an intent outside the four buckets", async () => {
    const p = await makePerson();
    const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await expect(
      t.client`insert into participation (person_id, burn_id, intent) values (${p.id}, ${season.id}, 'maybe')`,
    ).rejects.toThrow(/participation_intent_ck/);
  });

  it("allows two people to share an email but not a login", async () => {
    await makePerson({ email: "shared@example.com" });
    await makePerson({ email: "shared@example.com" });
    await t.db.insert(user).values({ id: "auth-1", name: "x", email: "a1@example.com" });
    await makePerson({ authUserId: "auth-1" });
    await expect(makePerson({ authUserId: "auth-1" })).rejects.toThrow();
  });

  it("ends transactions left idle, for every new session", async () => {
    const url = new URL(t.runtimeUrl);
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const [r] = await sql`select current_setting('idle_in_transaction_session_timeout') as v`;
      expect(r.v).toBe("1min");
    } finally {
      await sql.end();
    }
  });

  it("applies migrations idempotently", async () => {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { fileURLToPath } = await import("node:url");
    await migrate(t.db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    const years = await t.db.select().from(burn);
    expect(years).toHaveLength(4);
  });
});
