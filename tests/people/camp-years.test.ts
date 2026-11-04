// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, burn, participation, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import {
  campYears,
  pastSeasons,
  pastYearbook,
  pastYearbookYears,
  setCampYear,
} from "~/lib/data/history.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";

let t: TestDb;
let years: Map<number, string>;

beforeAll(async () => {
  t = await createTestDb();
  years = new Map((await t.db.select().from(burn)).map((b) => [b.year, b.id]));
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, participation, audit_log cascade`;
});

async function makePerson(values: Partial<typeof person.$inferInsert> = {}) {
  const [p] = await t.db
    .insert(person)
    .values({ legalName: "Ana Lopez", ...values })
    .returning();
  return p;
}

async function came(personId: string, year: number, attended: boolean | null = true) {
  await t.db
    .insert(participation)
    .values({ personId, burnId: years.get(year) as string, attended });
}

async function lead(): Promise<Viewer> {
  const p = await makePerson({ legalName: "Lead Person" });
  return {
    personId: p.id,
    authUserId: "x",
    legalName: "Lead Person",
    playaName: null,
    ...asRoles(["lead"]),
  };
}

async function row(personId: string, year: number) {
  const [r] = await t.db
    .select()
    .from(participation)
    .where(
      and(
        eq(participation.personId, personId),
        eq(participation.burnId, years.get(year) as string),
      ),
    );
  return r;
}

describe("camp years", () => {
  it("lists past attended years only, ascending, ignoring 2027 intent", async () => {
    const p = await makePerson();
    await came(p.id, 2026);
    await came(p.id, 2024);
    await t.db.insert(participation).values({
      personId: p.id,
      burnId: years.get(2027) as string,
      intent: "going",
      attended: true,
    });
    expect((await campYears(t.db, [p.id])).get(p.id)).toEqual([2024, 2026]);
  });

  it("does not count attended = false or unknown", async () => {
    const p = await makePerson();
    await came(p.id, 2025, false);
    await came(p.id, 2026, null);
    expect((await campYears(t.db, [p.id])).has(p.id)).toBe(false);
    expect(await campYears(t.db, [])).toEqual(new Map());
  });

  it("lists past Yearbook years that have campers, newest first", async () => {
    expect(await pastYearbookYears(t.db)).toEqual([]);
    const p = await makePerson();
    await came(p.id, 2024);
    await came(p.id, 2026);
    await came(p.id, 2025, false);
    expect(await pastYearbookYears(t.db)).toEqual([2026, 2024]);
    expect(await pastSeasons(t.db)).toEqual([2024, 2025, 2026]);
  });
});

describe("setCampYear", () => {
  it("inserts a missing year and audits it; 'no' updates the same row", async () => {
    const actor = await lead();
    const p = await makePerson();
    await setCampYear(t.db, actor, p.id, 2025, "yes");
    expect((await row(p.id, 2025)).attended).toBe(true);
    await setCampYear(t.db, actor, p.id, 2025, "no");
    expect((await row(p.id, 2025)).attended).toBe(false);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "camp_year_set"));
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.after)).toContainEqual({ year: 2025, attended: false });
  });

  it("keeps an imported 2026 pre-burn intent when changed", async () => {
    const actor = await lead();
    const p = await makePerson();
    await t.db.insert(participation).values({
      personId: p.id,
      burnId: years.get(2026) as string,
      preBurnIntent: "yes_going",
      attended: true,
    });
    await setCampYear(t.db, actor, p.id, 2026, "no");
    await setCampYear(t.db, actor, p.id, 2026, "unknown");
    const r = await row(p.id, 2026);
    expect(r.attended).toBeNull();
    expect(r.preBurnIntent).toBe("yes_going");
  });

  it("writes nothing for 'unknown' on a year with no row, or an unchanged value", async () => {
    const actor = await lead();
    const p = await makePerson();
    await setCampYear(t.db, actor, p.id, 2024, "unknown");
    expect(await row(p.id, 2024)).toBeUndefined();
    await came(p.id, 2025);
    await setCampYear(t.db, actor, p.id, 2025, "yes");
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it("refuses the current season, future and unknown years, and non-Leads", async () => {
    const actor = await lead();
    const p = await makePerson();
    for (const y of [2027, 2030, 2019]) {
      await expect(setCampYear(t.db, actor, p.id, y, "yes")).rejects.toMatchObject({
        data: { reason: "bad_camp_year" },
      });
    }
    await expect(
      setCampYear(t.db, { ...actor, ...asRoles([]) }, p.id, 2025, "yes"),
    ).rejects.toMatchObject({ data: { reason: "forbidden" } });
    expect(await t.db.select().from(participation)).toHaveLength(0);
  });
});

describe("pastYearbook", () => {
  it("splits that year's active campers into photo cards and names, labels only", async () => {
    const withPhoto = await makePerson({
      legalName: "Ana Lopez",
      playaName: "Sparrow",
      photoKey: "p/a.webp",
      yearbookShowFirstName: true,
    });
    const noPhoto = await makePerson({ legalName: "Ben Okafor", playaName: "Tinker" });
    const noPlaya = await makePerson({ legalName: "Cara Smithson" });
    const gone = await makePerson({ legalName: "Dee Gone", playaName: "Ghost", active: false });
    const otherYear = await makePerson({ legalName: "Eve Other", playaName: "Later" });
    for (const p of [withPhoto, noPhoto, noPlaya, gone]) await came(p.id, 2025);
    await came(withPhoto.id, 2024);
    await came(otherYear.id, 2026);

    const yb = await pastYearbook(t.db, 2025);
    expect(yb.cards).toEqual([
      { key: "p/a.webp", label: "Sparrow", secondary: "Ana", years: [2024, 2025] },
    ]);
    expect(yb.names).toEqual([
      { label: "Cara", years: [2025] },
      { label: "Tinker", years: [2025] },
    ]);
    const json = JSON.stringify(yb);
    for (const leak of ["Lopez", "Okafor", "Smithson", "Ghost", "Later", noPhoto.id]) {
      expect(json).not.toContain(leak);
    }
  });
});
