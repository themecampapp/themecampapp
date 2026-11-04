// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  burn,
  dues,
  memberRole,
  participation,
  ticketRequest,
  volunteerRole,
  volunteerSignup,
} from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu } from "../helpers/two-camps";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// The Lead workspace plan, Phase B: the season roster (Unit 5), a person beside it (Unit 6),
// and the Lead home's Overview (Unit 7).

let t: TestDb;
let w: TestWorker;
let lead: string;
let treasurer: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  await seedZulu(t);
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead", playaName: "Lee" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  const tr = await invitePerson(t, "tia@example.com", { legalName: "Tia Treasurer" });
  await t.db.insert(memberRole).values([
    { personId: tr.id, role: "lead" },
    { personId: tr.id, role: "treasurer" },
  ]);
  lead = await signIn(w, "lead@example.com");
  treasurer = await signIn(w, "tia@example.com");
  await w.fetch(get("/", lead));
  await w.fetch(get("/", treasurer));

  const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  const camper = async (
    key: string,
    intent: "going" | "leaning_yes" | null,
    extra: Partial<typeof participation.$inferInsert> = {},
  ) => {
    const p = await invitePerson(t, `${key.toLowerCase()}@example.com`, {
      legalName: `${key} Fullname`,
      playaName: key,
    });
    ids[key] = p.id;
    if (!intent) return null;
    const [pa] = await t.db
      .insert(participation)
      .values({ personId: p.id, burnId: season.id, intent, ...extra })
      .returning();
    return pa;
  };
  const gus = await camper("Gus", "going", {
    sapRequested: true,
    sapDate: "2027-08-24",
    arrivalDate: "2027-08-24",
  });
  const gia = await camper("Gia", "going", { arrivalDate: "2027-08-28" });
  await camper("Gil", "going", { arrivalDate: "2027-08-26" });
  await camper("Lyn", "leaning_yes");
  await camper("Nia", null);
  await t.db.insert(ticketRequest).values([
    { participationId: gus?.id as string, ticketsNeeded: 2, vehiclePassNeeded: true },
    { participationId: gia?.id as string, ticketsNeeded: 0, hasTicketElsewhere: true },
  ]);
  await t.db.insert(dues).values({ participationId: gus?.id as string, status: "paid" });
  const [role] = await t.db
    .select()
    .from(volunteerRole)
    .where(eq(volunteerRole.title, "Volunteer Coordinator"));
  await t.db
    .insert(volunteerSignup)
    .values({ burnId: season.id, roleId: role.id, personId: ids.Gus });
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const page = async (path: string, cookie = lead) => (await w.fetch(get(path, cookie))).text();
// The campers a roster page lists, in order (the table's name links).
const names = (html: string) =>
  [...html.matchAll(/href="\/roster\/[0-9a-f-]{36}[^"]*"[^>]*>([^<]+)</g)]
    .map((m) => m[1])
    .filter((n, i, all) => all.indexOf(n) === i);

describe("the season roster (Unit 5)", () => {
  it("finds a camper by legal name, playa name or email", async () => {
    expect(names(await page("/roster?q=gil%20full"))).toEqual(["Gil"]);
    expect(names(await page("/roster?q=gus"))).toEqual(["Gus"]);
    expect(names(await page("/roster?q=gia%40example"))).toEqual(["Gia"]);
  });

  it("combines filters, and sorts", async () => {
    // Going, and no ticket request: not Gus (requested) or Gia (has one elsewhere).
    expect(names(await page("/roster?rsvp=going&ticket=missing"))).toEqual(["Gil"]);
    expect(names(await page("/roster?rsvp=going&sort=arrival"))).toEqual(["Gus", "Gil", "Gia"]);
  });

  it("has presets for the usual questions", async () => {
    // The two Leads haven't RSVP'd either.
    expect(names(await page("/roster?preset=no-rsvp"))).toEqual(["Lee", "Nia", "Tia Treasurer"]);
    expect(names(await page("/roster?preset=pending-sap"))).toEqual(["Gus"]);
    expect(names(await page("/roster?preset=no-volunteer"))).toEqual(["Gia", "Gil", "Lyn"]);
    const arrivals = await page("/roster?preset=arrivals");
    expect(arrivals).toContain("Arrival unknown");
  });

  it("shows request states in words", async () => {
    const html = await page("/roster?rsvp=going");
    expect(html).toContain("2 tickets requested + vehicle pass");
    expect(html).toContain("Has ticket elsewhere");
    expect(html).toContain("Not requested");
  });

  it("ignores values it doesn't know", async () => {
    expect(names(await page("/roster?rsvp=maybe&sort=bogus&ticket=x"))).toEqual(
      names(await page("/roster")),
    );
  });

  it("never shows dues to a Lead who isn't the Treasurer, however it's asked", async () => {
    for (const path of [
      "/roster?dues=paid&cols=dues,rsvp&preset=unpaid",
      "/roster.data?dues=paid&cols=dues&preset=unpaid",
    ]) {
      const html = await page(path);
      expect(html, path).not.toMatch(/>Dues</);
      expect(html, path).not.toMatch(/Paid|"paid"|Dues unpaid/);
    }
    // The dues filter was dropped, not applied: everyone's still listed.
    expect(names(await page("/roster?dues=paid"))).toContain("Gil");
  });

  it("shows the Treasurer dues as a column and a filter", async () => {
    const html = await page("/roster?dues=paid&cols=rsvp,dues", treasurer);
    expect(names(html)).toEqual(["Gus"]);
    expect(html).toMatch(/>Dues</);
    expect(html).toContain(">Paid<");
  });

  it("never lists another camp's people", async () => {
    const html = await page("/roster?q=zzb");
    expect(names(html)).toEqual([]);
    expect(html).toContain("0 people");
  });
});

describe("a person beside the roster (Unit 6)", () => {
  it("shows their season, and steps through the same filtered list", async () => {
    const html = await page(`/roster/${ids.Gia}?rsvp=going`);
    expect(html).toContain("Gia Fullname");
    expect(html).toContain("Has a ticket elsewhere");
    // Name order: Gia, Gil, Gus.
    expect(html).toContain(`href="/roster/${ids.Gil}?rsvp=going"`);
    expect(html).not.toContain("← Previous");
    const last = await page(`/roster/${ids.Gus}?rsvp=going`);
    expect(last).toContain(`href="/roster/${ids.Gil}?rsvp=going"`);
    expect(last).not.toContain("Next →");
    expect(last).toContain('href="/roster?rsvp=going"');
  });

  it("says when the person isn't in the list any more", async () => {
    expect(await page(`/roster/${ids.Lyn}?rsvp=going`)).toContain("Not in this list any more");
  });

  it("keeps dues to the Treasurer", async () => {
    expect(await page(`/roster/${ids.Gus}`)).not.toMatch(/>Dues<|Paid/);
    expect(await page(`/roster/${ids.Gus}`, treasurer)).toMatch(/>Dues<[\s\S]*Paid/);
  });

  it("isn't there for a malformed id", async () => {
    const res = await w.fetch(get("/roster/not-an-id", lead));
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("the Lead home's Overview (Unit 7)", () => {
  it("lists what the camp needs, each linking to its list", async () => {
    const html = await page("/");
    expect(html).toContain("Camp to-dos");
    expect(html).toMatch(/href="\/roster\?preset=no-rsvp"[^>]*>3 people invited, no RSVP yet/);
    expect(html).toMatch(
      /href="\/tickets\?show=missing"[^>]*>2 campers coming without a ticket request/,
    );
    expect(html).toMatch(/href="\/saps"[^>]*>1 SAP request to decide/);
    expect(html).not.toContain("dues unpaid");
  });

  it("adds unpaid dues for the Treasurer", async () => {
    expect(await page("/", treasurer)).toMatch(
      /href="\/roster\?preset=unpaid"[^>]*>3 campers coming with dues unpaid/,
    );
  });

  it("badges My participation when the Lead has to-dos of their own", async () => {
    // Lee hasn't RSVP'd.
    expect(await page("/")).toMatch(/My participation[\s\S]{0,200}>1<[\s\S]{0,60}to do/);
  });
});
