// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, invite, participation, person } from "~/db/schema";
import { applyFilters, seasonCounts, seasonRows } from "~/lib/data/season-roster.server";
import { readRosterQuery } from "~/lib/roster-filters";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

async function camper(
  name: string,
  rsvp: Partial<typeof participation.$inferInsert> | null,
  opts: { invited?: boolean; active?: boolean } = {},
) {
  const [p] = await t.db
    .insert(person)
    .values({
      legalName: name,
      email: `${name.toLowerCase()}@example.com`,
      active: opts.active ?? true,
    })
    .returning();
  if (opts.invited ?? true)
    await t.db.insert(invite).values({ personId: p.id, email: p.email as string });
  if (rsvp) {
    const [y27] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await t.db.insert(participation).values({ personId: p.id, burnId: y27.id, ...rsvp });
  }
  return p;
}

beforeAll(async () => {
  t = await createTestDb();
  await camper("Ana", {
    intent: "going",
    arrivalDate: "2027-08-28",
    generator: true,
    sapRequested: true,
  });
  await camper("Ben", { intent: "going", arrivalDate: "2027-08-30" });
  await camper("Cy", { intent: "leaning_yes" });
  await camper("Dee", { intent: "leaning_no", generator: true });
  await camper("Eve", null);
  await camper("Fin", null, { invited: false });
  await camper("Gus", { intent: "going", arrivalDate: "2027-08-25" }, { active: false });
});
afterAll(async () => {
  await t.drop();
});

// The season roster's data (app/lib/data/season-roster.server.ts); its pages are tested in
// tests/lead/season-roster.test.ts.
const view = async (search: string) =>
  applyFilters(
    await seasonRows(t.db, { dues: false, contact: true }),
    readRosterQuery(new URLSearchParams(search), false).filters,
  ).map((r) => r.name);

describe("roster", () => {
  it("counts intents and invited people with no RSVP, excluding deactivated and never-invited", async () => {
    const s = seasonCounts(await seasonRows(t.db, { dues: false, contact: true }), false);
    expect(s).toMatchObject({ going: 2, leaningYes: 1, leaningNo: 1, notGoing: 0, noRsvp: 1 });
    expect(s.unpaid).toBeNull();
  });

  it("orders arrivals by date for people coming, with unknown last", async () => {
    expect(await view("preset=arrivals")).toEqual(["Ana", "Ben", "Cy"]);
  });

  it("lists generators and SAP requests only for people coming", async () => {
    expect(await view("preset=generators")).toEqual(["Ana"]);
    expect(await view("preset=sap")).toEqual(["Ana"]);
  });

  it("shows who still needs to RSVP", async () => {
    expect(await view("preset=no-rsvp")).toEqual(["Eve"]);
  });
});
