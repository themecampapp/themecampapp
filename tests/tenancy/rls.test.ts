// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, authEvent, burn, camp, campSettings, participation, person } from "~/db/schema";
import { campTables } from "../../scripts/db-grants";
import { createTestDb, type TestDb } from "../helpers/db";
import { ROLE_PASSWORD } from "../setup/roles";

// Row-level security, exercised as the camp Worker's real role (app_runtime), which can't
// bypass it. Camp A is the test database's seeded camp; camp B is added here.
let t: TestDb;
let runtime: ReturnType<typeof postgres>;
let campA: string;
let campB: string;
let personB: string;

const asRuntimeUrl = (url: string) => {
  const u = new URL(url);
  u.username = "app_runtime";
  u.password = ROLE_PASSWORD;
  return u.toString();
};

// One transaction as app_runtime, acting for `campId` (or for no camp).
async function asCamp<T>(
  campId: string | null,
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await runtime.begin(async (sql) => {
    if (campId) await sql`select set_config('app.camp_id', ${campId}, true)`;
    return fn(sql);
  })) as T;
}

beforeAll(async () => {
  t = await createTestDb();
  campA = t.campId;
  const [b] = await t.db.insert(camp).values({ slug: "otherband", name: "Other Band" }).returning();
  campB = b.id;
  // As the test superuser (which bypasses RLS), give camp B rows in several tables.
  const [p] = await t.db
    .insert(person)
    .values({ campId: campB, legalName: "Bea Otherband", email: "bea@example.com" })
    .returning();
  personB = p.id;
  const [yB] = await t.db.insert(burn).values({ campId: campB, year: 2027 }).returning();
  await t.db.insert(burn).values({ campId: campB, year: 2031 });
  await t.db.insert(campSettings).values({ campId: campB, currentYear: 2031 });
  await t.db.insert(participation).values({ campId: campB, personId: personB, burnId: yB.id });
  await t.db
    .insert(auditLog)
    .values({ campId: campB, action: "test", subjectType: "person", subjectId: personB });
  // And camp A a person of its own.
  await t.db.insert(person).values({ campId: campA, legalName: "Ada Testcamp" });
  // max: 1, so consecutive transactions share one server connection, as Hyperdrive's pool can.
  runtime = postgres(asRuntimeUrl(t.url), { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await runtime.end();
  await t.drop();
});

describe("row-level security as app_runtime", () => {
  it("shows a camp only its own rows, in every camp table", async () => {
    const tables = await campTables(t.client);
    expect(tables.length).toBeGreaterThanOrEqual(23);
    for (const [mine, otherName] of [
      [campA, "Bea Otherband"],
      [campB, "Ada Testcamp"],
    ]) {
      await asCamp(mine, async (sql) => {
        for (const table of tables) {
          const [r] = await sql.unsafe(
            `select count(*)::int as n from "${table}" where camp_id <> $1`,
            [mine],
          );
          expect(r.n, `${table} shows another camp's rows`).toBe(0);
        }
        const names = (await sql`select legal_name from person`).map((r) => r.legal_name);
        expect(names).not.toContain(otherName);
      });
    }
    await asCamp(campB, async (sql) => {
      const [r] = await sql`select count(*)::int as n from participation`;
      expect(r.n).toBe(1);
    });
  });

  it("with no camp set (and two camps), sees nothing and can't insert", async () => {
    await asCamp(null, async (sql) => {
      for (const table of await campTables(t.client)) {
        const [r] = await sql.unsafe(`select count(*)::int as n from "${table}"`);
        expect(r.n, `${table} is visible with no camp set`).toBe(0);
      }
    });
    await expect(
      asCamp(null, (sql) => sql`insert into person (legal_name) values ('Nobody')`),
    ).rejects.toThrow(/row-level security|camp_id/);
  });

  it("fills camp_id from the transaction's camp and refuses another camp's", async () => {
    const [row] = await asCamp(
      campA,
      (sql) => sql`insert into person (legal_name) values ('Defaulted') returning camp_id`,
    );
    expect(row.camp_id).toBe(campA);
    await expect(
      asCamp(
        campA,
        (sql) => sql`insert into person (camp_id, legal_name) values (${campB}, 'Smuggled')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("can't update or delete another camp's rows (they're invisible)", async () => {
    const updated = await asCamp(
      campA,
      (sql) => sql`update person set legal_name = 'Hacked' where id = ${personB}`,
    );
    expect(updated.count).toBe(0);
    const deleted = await asCamp(campA, (sql) => sql`delete from person where id = ${personB}`);
    expect(deleted.count).toBe(0);
    const [p] = await t.db.select().from(person).where(eq(person.id, personB));
    expect(p.legalName).toBe("Bea Otherband");
  });

  it("doesn't keep a camp across transactions on the same connection", async () => {
    await asCamp(campA, async (sql) => {
      const [r] = await sql`select count(*)::int as n from person`;
      expect(r.n).toBeGreaterThan(0);
    });
    // The setting now reads '' on this pooled connection, not NULL: still no camp.
    await asCamp(null, async (sql) => {
      const [s] = await sql`select current_setting('app.camp_id', true) as v`;
      expect(s.v).toBe("");
      const [r] = await sql`select count(*)::int as n from person`;
      expect(r.n).toBe(0);
    });
  });

  it("gives each camp its own current season", async () => {
    const yearOf = (id: string | null) =>
      asCamp(id, async (sql) => (await sql`select current_year() as y`)[0].y);
    expect(await yearOf(campA)).toBe(2027);
    expect(await yearOf(campB)).toBe(2031);
    expect(await yearOf(null)).toBeNull();
  });

  it("can't write camp, change audit_log, or skip RLS", async () => {
    await expect(
      asCamp(campA, (sql) => sql`update camp set status = 'active' where id = ${campA}`),
    ).rejects.toThrow(/permission denied/);
    await expect(asCamp(campA, (sql) => sql`delete from audit_log`)).rejects.toThrow(
      /permission denied/,
    );
    const [who] = await runtime`
      select current_user as u, rolbypassrls, rolsuper from pg_roles where rolname = current_user`;
    expect(who).toMatchObject({ u: "app_runtime", rolbypassrls: false, rolsuper: false });
  });
});

describe("references between camps", () => {
  it("can't point a camp A row at camp B's person, even as the table owner", async () => {
    const [yA] = await t.db.select().from(burn).where(eq(burn.campId, campA)).limit(1);
    await expect(
      t.db.insert(participation).values({ campId: campA, personId: personB, burnId: yA.id }),
    ).rejects.toThrow();
    const [r] = await t.client`
      select count(*)::int as n from participation where person_id = ${personB} and camp_id = ${campA}`;
    expect(r.n).toBe(0);
  });

  it("gives one login a separate person in each camp, but only one per camp", async () => {
    await t.client`insert into "user" (id, name, email) values ('login-1', 'x', 'l1@example.com')`;
    await t.db.insert(person).values({ campId: campA, legalName: "Lu A", authUserId: "login-1" });
    await t.db.insert(person).values({ campId: campB, legalName: "Lu B", authUserId: "login-1" });
    await expect(
      t.db.insert(person).values({ campId: campA, legalName: "Lu A2", authUserId: "login-1" }),
    ).rejects.toThrow();
  });

  it("lets two camps use the same season year", async () => {
    const years = await t.db.select().from(burn).where(eq(burn.year, 2027));
    expect(new Set(years.map((y) => y.campId))).toEqual(new Set([campA, campB]));
  });

  it("deleting a person keeps their sign-in log rows but forgets who they were", async () => {
    const [p] = await t.db
      .insert(person)
      .values({ campId: campB, legalName: "Leaving Soon" })
      .returning();
    const [ev] = await t.db
      .insert(authEvent)
      .values({ campId: campB, event: "link_requested", personId: p.id })
      .returning();
    await t.db.delete(person).where(eq(person.id, p.id));
    const [after] = await t.db.select().from(authEvent).where(eq(authEvent.id, ev.id));
    expect(after).toMatchObject({ personId: null, campId: campB });
  });

  it("refuses to delete a camp that isn't due for deletion (R44)", async () => {
    await expect(t.client`delete from camp where id = ${campB}`).rejects.toThrow(
      /not due for deletion/,
    );
    await t.db
      .update(camp)
      .set({ status: "pending_deletion", deleteAfter: new Date(Date.now() + 86400_000) })
      .where(eq(camp.id, campB));
    await expect(t.client`delete from camp where id = ${campB}`).rejects.toThrow(
      /not due for deletion/,
    );
  });

  it("deleting a camp removes all its rows and nobody else's", async () => {
    const tables = await campTables(t.client);
    await t.db
      .update(camp)
      .set({ status: "pending_deletion", deleteAfter: new Date(Date.now() - 1000) })
      .where(eq(camp.id, campB));
    await t.db.delete(camp).where(eq(camp.id, campB));
    for (const table of tables) {
      const [r] = await t.client.unsafe(
        `select count(*)::int as n from "${table}" where camp_id = $1`,
        [campB],
      );
      expect(r.n, `${table} kept camp B rows`).toBe(0);
    }
    const [a] = await t.client`select count(*)::int as n from person where camp_id = ${campA}`;
    expect(a.n).toBeGreaterThan(0);
  });
});

describe("with a single camp", () => {
  let solo: TestDb;
  let soloRuntime: ReturnType<typeof postgres>;
  beforeAll(async () => {
    solo = await createTestDb();
    soloRuntime = postgres(solo.runtimeUrl, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await soloRuntime.end();
    await solo.drop();
  });

  it("still sees nothing when no camp is set (no 'only camp' fallback)", async () => {
    const [r] = await soloRuntime`select current_camp_id() as c, current_year() as y`;
    expect(r).toEqual({ c: null, y: null });
    const [p] = await soloRuntime`select count(*)::int as n from person`;
    expect(p.n).toBe(0);
  });
});
