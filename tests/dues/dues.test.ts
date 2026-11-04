// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, burn, dues, memberRole, participation, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import {
  duesBoard,
  formatCents,
  getDuesSettings,
  isUnpaid,
  myDues,
  parseDollars,
  recordDues,
  setDuesSettings,
  summarizeDues,
} from "~/lib/data/dues.server";
import { type Intent, saveRsvp } from "~/lib/data/participation.server";
import { seasonCounts, seasonRows } from "~/lib/data/season-roster.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

const paid = { status: "paid", amount: "", paidOn: "2027-02-01", method: "venmo" };

describe("parseDollars and formatCents", () => {
  it("reads dollars in the usual forms", () => {
    expect(parseDollars("150")).toBe(15000);
    expect(parseDollars(" $1,250.5 ")).toBe(125050);
    expect(parseDollars("0.99")).toBe(99);
    expect(parseDollars("")).toBeNull();
    expect(formatCents(15000)).toBe("$150");
    expect(formatCents(125050)).toBe("$1,250.50");
  });

  it("refuses anything else", () => {
    for (const bad of ["abc", "-5", "1.234", "1e3", "9999999"]) {
      expect(() => parseDollars(bad)).toThrow();
    }
  });
});

describe("dues data layer", () => {
  let t: TestDb;
  let season: string;
  let treasurer: Viewer;
  let lead: Viewer;

  beforeAll(async () => {
    t = await createTestDb();
    [{ id: season }] = await t.db.select({ id: burn.id }).from(burn).where(eq(burn.year, 2027));
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.client`truncate person, participation, dues, audit_log cascade`;
    await t.db.update(burn).set({ duesAmountCents: null, paymentInstructions: null });
    const [p] = await t.db.insert(person).values({ legalName: "Terry Treasurer" }).returning();
    treasurer = {
      personId: p.id,
      authUserId: "x",
      legalName: p.legalName,
      playaName: null,
      ...asRoles(["treasurer"]),
    };
    lead = { ...treasurer, ...asRoles(["lead"]) };
  });

  async function camper(name: string, intent: Intent | null, active = true) {
    const [p] = await t.db.insert(person).values({ legalName: name, active }).returning();
    if (intent) await t.db.insert(participation).values({ personId: p.id, burnId: season, intent });
    return p;
  }

  it("lets only a Treasurer set the amount and instructions, audited", async () => {
    await expect(
      setDuesSettings(t.db, lead, { amount: "150", instructions: "Venmo @yb" }),
    ).rejects.toMatchObject({ data: { reason: "forbidden" } });
    await setDuesSettings(t.db, treasurer, { amount: "150", instructions: "  Venmo @yb  " });
    expect(await getDuesSettings(t.db)).toEqual({
      year: 2027,
      amountCents: 15000,
      instructions: "Venmo @yb",
      tiers: [],
    });
    const [a] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "dues_settings_updated"));
    expect(a.after).toEqual({ amountCents: 15000, instructions: "Venmo @yb" });
  });

  it("lists who owes dues: coming campers, unpaid by default", async () => {
    await camper("Going Gal", "going");
    await camper("Leaning Lee", "leaning_yes");
    await camper("Maybe Not", "leaning_no");
    await camper("No Rsvp", null);
    await camper("Gone Gus", "going", false);
    const rows = await duesBoard(t.db);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["Going Gal", "unpaid"],
      ["Leaning Lee", "unpaid"],
    ]);
    expect(summarizeDues(rows)).toMatchObject({ unpaid: 2, paid: 0, collectedCents: 0 });
  });

  it("records a payment, defaulting the amount to the season's, and audits it", async () => {
    await setDuesSettings(t.db, treasurer, { amount: "150", instructions: "" });
    const p = await camper("Going Gal", "going");
    await recordDues(t.db, treasurer, p.id, paid);
    const [row] = await duesBoard(t.db);
    expect(row).toMatchObject({
      status: "paid",
      amountCents: 15000,
      paidOn: "2027-02-01",
      method: "venmo",
    });
    expect(summarizeDues([row])).toMatchObject({ unpaid: 0, paid: 1, collectedCents: 15000 });
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, "dues_updated"));
    expect(a).toMatchObject({ actorPersonId: treasurer.personId, subjectId: p.id, before: null });
  });

  it("clears payment details when set back to Unpaid or Waived", async () => {
    const p = await camper("Going Gal", "going");
    await recordDues(t.db, treasurer, p.id, { ...paid, amount: "80" });
    await recordDues(t.db, treasurer, p.id, { ...paid, status: "waived" });
    const [row] = await duesBoard(t.db);
    expect(row).toMatchObject({ status: "waived", amountCents: null, paidOn: null, method: null });
  });

  it("refuses bad or missing payment details, and non-Treasurers", async () => {
    const p = await camper("Going Gal", "going");
    const reason = (input: typeof paid, actor = treasurer) =>
      recordDues(t.db, actor, p.id, input).then(
        () => null,
        (e) => e.data.reason,
      );
    expect(await reason(paid)).toBe("dues_amount_needed"); // no season amount, none given
    expect(await reason({ ...paid, amount: "150", paidOn: "" })).toBe("dues_date_needed");
    expect(await reason({ ...paid, amount: "150", paidOn: "2027-13-45" })).toBe("dues_date_needed");
    expect(await reason({ ...paid, amount: "150", method: "bitcoin" })).toBe("dues_method_needed");
    expect(await reason({ ...paid, amount: "lots" })).toBe("bad_amount");
    expect(await reason({ ...paid, status: "partial" })).toBe("bad_status");
    expect(await reason({ ...paid, amount: "150" }, lead)).toBe("forbidden");
    expect(await t.db.select().from(dues)).toHaveLength(0);
  });

  it("refuses recording dues for someone who isn't coming", async () => {
    const p = await camper("Maybe Not", "leaning_no");
    const q = await camper("No Rsvp", null);
    for (const id of [p.id, q.id]) {
      await expect(
        recordDues(t.db, treasurer, id, { ...paid, amount: "150" }),
      ).rejects.toMatchObject({
        data: { reason: "dues_not_coming" },
      });
    }
  });

  it("keeps a paid camper who switches to Not going, flagged, until the Treasurer saves", async () => {
    const p = await camper("Going Gal", "going");
    await recordDues(t.db, treasurer, p.id, { ...paid, amount: "150" });
    await saveRsvp(t.db, p.id, p.id, {
      intent: "not_going",
      arrivalDate: null,
      departureDate: null,
      sapRequested: null,
      sapDate: null,
      dwellingDescription: null,
      dwellingSize: null,
      generator: null,
    });
    let [row] = await duesBoard(t.db);
    expect(row).toMatchObject({ status: "paid", flagged: true, intent: "not_going" });
    expect(isUnpaid(row)).toBe(false);

    await recordDues(t.db, treasurer, p.id, { ...paid, status: "unpaid" }); // refunded
    [row] = await duesBoard(t.db);
    expect(row).toMatchObject({ status: "unpaid", flagged: false });
    expect(isUnpaid(row)).toBe(false); // not coming, so not counted as owing
  });

  it("shows members only their own dues, and nothing when they aren't coming", async () => {
    const a = await camper("Going Gal", "going");
    const b = await camper("Maybe Not", "leaning_no");
    expect(await myDues(t.db, a.id)).toMatchObject({
      status: "unpaid",
      owedCents: null,
      tierName: null,
    });
    expect(await myDues(t.db, b.id)).toBeNull();
    await setDuesSettings(t.db, treasurer, { amount: "150", instructions: "Venmo @yb" });
    await recordDues(t.db, treasurer, a.id, paid);
    expect(await myDues(t.db, a.id)).toMatchObject({
      status: "paid",
      paidAmountCents: 15000,
      paidOn: "2027-02-01",
      instructions: "Venmo @yb",
    });
  });

  it("counts unpaid dues on the roster", async () => {
    const a = await camper("Going Gal", "going");
    await camper("Leaning Lee", "leaning_yes");
    await camper("Maybe Not", "leaning_no");
    const unpaid = async () => seasonCounts(await seasonRows(t.db, { dues: true, contact: true }), true).unpaid;
    expect(await unpaid()).toBe(2);
    await recordDues(t.db, treasurer, a.id, { ...paid, status: "waived" });
    expect(await unpaid()).toBe(1);
  });
});

describe("dues pages through the real Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    const [{ id: season }] = await t.db
      .select({ id: burn.id })
      .from(burn)
      .where(eq(burn.year, 2027));
    const people: Array<[string, Array<"lead" | "treasurer">]> = [
      ["lead", ["lead"]],
      ["treasurer", ["treasurer"]],
      ["both", ["lead", "treasurer"]],
      ["member", []],
      ["other", []],
    ];
    for (const [who, roles] of people) {
      const p = await invitePerson(t, `${who}@example.com`, { legalName: `${who} Person` });
      ids[who] = p.id;
      for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
      await t.db.insert(participation).values({ personId: p.id, burnId: season, intent: "going" });
      cookies[who] = await signIn(w, `${who}@example.com`);
    }
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("refuses the dues page to Members, and shows them only their own card", async () => {
    expect((await w.fetch(get("/dues", cookies.member))).status).toBe(403);
    const home = await (await w.fetch(get("/", cookies.member))).text();
    expect(home).toContain("aren&#x27;t set yet");
    expect(home).not.toContain("other Person");
  });

  it("lets a Treasurer who isn't a Lead set dues and record a payment, but not see Lead pages", async () => {
    expect((await w.fetch(get("/roster", cookies.treasurer))).status).toBe(403);
    const page = await w.fetch(get("/dues", cookies.treasurer));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("member Person");

    const s = await w.fetch(
      post(
        "/dues",
        { intent: "settings", amount: "150", instructions: "Venmo @yellowballoon" },
        { cookie: cookies.treasurer },
      ),
    );
    expect(s.status).toBe(302);
    const r = await w.fetch(
      post(
        "/dues",
        { personId: ids.member, status: "paid", amount: "", paidOn: "2027-02-01", method: "zelle" },
        { cookie: cookies.treasurer },
      ),
    );
    expect(r.status).toBe(302);

    const home = await (await w.fetch(get("/", cookies.member))).text();
    expect(home).toContain("Paid");
    const other = await (await w.fetch(get("/", cookies.other))).text();
    expect(other).toContain("$150 due");
    expect(other).toContain("Venmo @yellowballoon");
  });

  it("keeps dues from Leads who aren't the Treasurer: no page, no nav link, no roster count", async () => {
    const page = await w.fetch(get("/dues?view=all", cookies.lead));
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain("member Person");
    const home = await (await w.fetch(get("/", cookies.lead))).text();
    expect(home).not.toContain('href="/dues"');
    const roster = await (await w.fetch(get("/roster", cookies.lead))).text();
    expect(roster).not.toContain("Dues unpaid");
    // Asking for the unpaid view directly just shows everyone, with no dues information.
    const res0 = await w.fetch(get("/roster?preset=unpaid&dues=unpaid", cookies.lead));
    expect(res0.status).toBe(200);
    const direct = await res0.text();
    expect(direct).not.toMatch(/dues unpaid|Dues unpaid|>Unpaid</);

    const before = await t.db.select().from(dues);
    const res = await w.fetch(
      post(
        "/dues",
        { personId: ids.other, status: "waived", amount: "", paidOn: "", method: "" },
        { cookie: cookies.lead },
      ),
    );
    expect(res.status).toBe(403);
    expect(await t.db.select().from(dues)).toEqual(before);
    const settings = await w.fetch(
      post(
        "/dues",
        { intent: "settings", amount: "0", instructions: "" },
        { cookie: cookies.lead },
      ),
    );
    expect(settings.status).toBe(403);
    expect((await getDuesSettings(t.db)).amountCents).toBe(15000);
  });

  it("gives a Lead who is also the Treasurer the page and the roster count", async () => {
    expect((await w.fetch(get("/dues", cookies.both))).status).toBe(200);
    expect(await (await w.fetch(get("/", cookies.both))).text()).toContain('href="/dues"');
    expect(await (await w.fetch(get("/roster", cookies.both))).text()).toContain("Dues unpaid");
  });

  it("shows a friendly error for a bad payment and saves nothing", async () => {
    const res = await w.fetch(
      post(
        "/dues",
        {
          personId: ids.other,
          status: "paid",
          amount: "abc",
          paidOn: "2027-02-01",
          method: "cash",
        },
        { cookie: cookies.treasurer },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Enter an amount in dollars");
  });
});
