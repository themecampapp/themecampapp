// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, burn, dues, duesTier, memberRole, participation, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import {
  duesBoard,
  getDuesSettings,
  myDues,
  recordDues,
  removeDuesTier,
  saveDuesTier,
} from "~/lib/data/dues.server";
import { peopleCsv } from "~/lib/data/export.server";
import { rollOver } from "~/lib/data/season.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #63: named dues tiers (need-based, for certain Leads...) the Treasurer sets up and puts
// campers on. A camper on no tier owes the standard amount. Who is on which tier is private.

const paid = { status: "paid", amount: "", paidOn: "2027-02-01", method: "venmo" };
const reason = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e.data?.reason,
  );

describe("dues tiers: data layer", () => {
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
    await t.client`truncate person, participation, dues, dues_tier, audit_log cascade`;
    await t.client`update camp_settings set current_year = 2027`; // after the rollover test
    await t.db.update(burn).set({ duesAmountCents: 35000, paymentInstructions: null });
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

  async function camper(name: string) {
    const [p] = await t.db.insert(person).values({ legalName: name }).returning();
    await t.db.insert(participation).values({ personId: p.id, burnId: season, intent: "going" });
    return p;
  }
  const tiers = async () => (await getDuesSettings(t.db)).tiers;
  const tierId = async (name: string) => (await tiers()).find((x) => x.name === name)?.id ?? "";

  it("lets a Treasurer add and rename tiers, highest amount first, audited", async () => {
    await saveDuesTier(t.db, treasurer, { name: " Low   income ", amount: "200" });
    await saveDuesTier(t.db, treasurer, { name: "Kitchen lead", amount: "$150" });
    expect((await tiers()).map((x) => [x.name, x.amountCents])).toEqual([
      ["Low income", 20000],
      ["Kitchen lead", 15000],
    ]);
    await saveDuesTier(t.db, treasurer, {
      id: await tierId("Kitchen lead"),
      name: "Kitchen leads",
      amount: "100",
    });
    expect((await tiers()).at(-1)).toMatchObject({ name: "Kitchen leads", amountCents: 10000 });
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions.sort()).toEqual(["dues_tier_added", "dues_tier_added", "dues_tier_updated"]);
  });

  it("refuses non-Treasurers, blank names, missing amounts and duplicate names", async () => {
    await saveDuesTier(t.db, treasurer, { name: "Low income", amount: "200" });
    expect(await reason(saveDuesTier(t.db, lead, { name: "Mine", amount: "1" }))).toBe("forbidden");
    expect(await reason(saveDuesTier(t.db, treasurer, { name: "  ", amount: "1" }))).toBe(
      "dues_tier_name_needed",
    );
    expect(await reason(saveDuesTier(t.db, treasurer, { name: "x".repeat(61), amount: "1" }))).toBe(
      "dues_tier_name_needed",
    );
    expect(await reason(saveDuesTier(t.db, treasurer, { name: "Free", amount: "" }))).toBe(
      "dues_tier_amount_needed",
    );
    expect(await reason(saveDuesTier(t.db, treasurer, { name: "LOW INCOME", amount: "9" }))).toBe(
      "dues_tier_name_taken",
    );
    expect(
      await reason(saveDuesTier(t.db, treasurer, { id: "nope", name: "X", amount: "9" })),
    ).toBe("dues_tier_unknown");
    // A $0 tier is allowed (as well as Waived).
    await saveDuesTier(t.db, treasurer, { name: "Free", amount: "0" });
    expect(await tiers()).toHaveLength(2);
  });

  it("puts a camper on a tier: they owe its amount, and a payment defaults to it", async () => {
    await saveDuesTier(t.db, treasurer, { name: "Low income", amount: "200" });
    const low = await tierId("Low income");
    const a = await camper("Amy");
    const b = await camper("Bo");
    await recordDues(t.db, treasurer, a.id, { ...paid, status: "unpaid", tier: low });
    const board = await duesBoard(t.db);
    expect(board.map((r) => [r.name, r.tierName, r.owedCents])).toEqual([
      ["Amy", "Low income", 20000],
      ["Bo", null, 35000],
    ]);
    expect(await myDues(t.db, a.id)).toMatchObject({ owedCents: 20000, tierName: "Low income" });
    expect(await myDues(t.db, b.id)).toMatchObject({ owedCents: 35000, tierName: null });

    // No tier sent: the camper stays on theirs, and the payment is the tier's amount.
    await recordDues(t.db, treasurer, a.id, paid);
    const [amy] = await duesBoard(t.db);
    expect(amy).toMatchObject({ status: "paid", tierName: "Low income", amountCents: 20000 });
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "dues_updated"))
      .orderBy(auditLog.createdAt)
      .limit(1);
    expect(audit.after).toMatchObject({ tierId: low });

    // Back to standard, paid in the same save: the standard amount.
    await recordDues(t.db, treasurer, b.id, { ...paid, tier: low });
    await recordDues(t.db, treasurer, b.id, { ...paid, tier: "" });
    expect((await duesBoard(t.db))[1]).toMatchObject({ tierId: null, amountCents: 35000 });
  });

  it("refuses a tier that isn't this season's", async () => {
    const a = await camper("Amy");
    const [old] = await t.db.insert(burn).values({ year: 2020 }).returning();
    const [stale] = await t.db
      .insert(duesTier)
      .values({ burnId: old.id, name: "Old", amountCents: 100 })
      .returning();
    for (const tier of [stale.id, "not-a-tier"]) {
      expect(await reason(recordDues(t.db, treasurer, a.id, { ...paid, tier }))).toBe(
        "dues_tier_unknown",
      );
      expect(await reason(removeDuesTier(t.db, treasurer, tier))).toBe("dues_tier_unknown");
    }
    expect(await t.db.select().from(dues)).toHaveLength(0);
    await t.db.delete(burn).where(eq(burn.id, old.id)); // its tier goes with it
    expect(await t.db.select().from(duesTier)).toHaveLength(0);
  });

  it("removing a tier moves its campers to the standard amount and keeps what they paid", async () => {
    await saveDuesTier(t.db, treasurer, { name: "Low income", amount: "200" });
    const low = await tierId("Low income");
    const a = await camper("Amy");
    const b = await camper("Bo");
    await recordDues(t.db, treasurer, a.id, { ...paid, tier: low });
    await recordDues(t.db, treasurer, b.id, { ...paid, status: "unpaid", tier: low });
    expect(await reason(removeDuesTier(t.db, lead, low))).toBe("forbidden");
    expect(await removeDuesTier(t.db, treasurer, low)).toEqual({ name: "Low income", moved: 2 });
    const board = await duesBoard(t.db);
    expect(board.map((r) => [r.name, r.tierId, r.status, r.amountCents, r.owedCents])).toEqual([
      ["Amy", null, "paid", 20000, 35000],
      ["Bo", null, "unpaid", null, 35000],
    ]);
    const [a1] = await t.db.select().from(auditLog).where(eq(auditLog.action, "dues_tier_removed"));
    expect(a1.after).toEqual({ movedToStandard: 2 });
  });

  it("starts the next season with this season's tiers", async () => {
    await saveDuesTier(t.db, treasurer, { name: "Low income", amount: "200" });
    const admin = { ...treasurer, ...asRoles(["admin"]) };
    await rollOver(t.db, admin, { fromYear: 2027, came: [] });
    const next = await getDuesSettings(t.db);
    expect(next.year).toBe(2028);
    expect(next.tiers.map((x) => [x.name, x.amountCents])).toEqual([["Low income", 20000]]);
    // The old season keeps its own.
    expect(await t.db.select().from(duesTier).where(eq(duesTier.burnId, season))).toHaveLength(1);
  });

  it("puts each camper's tier in the Treasurer's export only", async () => {
    await saveDuesTier(t.db, treasurer, { name: "Low income", amount: "200" });
    const a = await camper("Amy");
    await camper("Bo");
    await recordDues(t.db, treasurer, a.id, {
      ...paid,
      status: "unpaid",
      tier: await tierId("Low income"),
    });
    const csv = await peopleCsv(t.db, { ...treasurer, ...asRoles(["lead", "treasurer"]) });
    expect(csv.split("\n")[0]).toContain("Dues tier");
    expect(csv).toMatch(/Amy[^\n]*Unpaid,Low income/);
    expect(csv).toMatch(/Bo[^\n]*Unpaid,Standard/);
    const forLead = await peopleCsv(t.db, lead);
    expect(forLead).not.toContain("Dues tier");
    expect(forLead).not.toContain("Low income");
  });
});

describe("dues tiers through the real Worker", () => {
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
    await t.db.update(burn).set({ duesAmountCents: 35000 }).where(eq(burn.id, season));
    const people: Array<[string, Array<"lead" | "treasurer" | "admin">]> = [
      ["treasurer", ["treasurer"]],
      ["admin", ["admin"]],
      ["lead", ["lead"]],
      ["amy", []],
      ["bo", []],
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

  const send = (fields: Record<string, string>, who = "treasurer") =>
    w.fetch(post("/dues", fields, { cookie: cookies[who] }));

  it("lets the Treasurer add a tier and put a camper on it from the Dues page", async () => {
    const added = await send({ intent: "tier_save", tierName: "Low income", amount: "200" });
    expect(added.status).toBe(302);
    const page = await (await w.fetch(get("/dues", cookies.treasurer))).text();
    expect(page).toContain("Dues tiers");
    expect(page).toContain("Standard ($350)");
    expect(page).toContain("Low income ($200)");
    const [tier] = await t.db.select().from(duesTier);
    const saved = await send({
      personId: ids.amy,
      name: "amy Person",
      status: "unpaid",
      tier: tier.id,
      amount: "",
      paidOn: "",
      method: "venmo",
    });
    expect(saved.status).toBe(302);
    const after = await (await w.fetch(get("/dues", cookies.treasurer))).text();
    expect(after).toContain('>Unpaid</span><span class="text-charcoal"> · Low income</span>');
    expect(after).toContain(" · owes $200");
  });

  it("shows a camper their own tier and amount, and nobody else's", async () => {
    const amy = await (await w.fetch(get("/", cookies.amy))).text();
    expect(amy).toContain("Pay your dues ($200)");
    expect(amy).toContain("$200 due");
    expect(amy).toContain("(Low income)");
    const bo = await (await w.fetch(get("/", cookies.bo))).text();
    expect(bo).toContain("$350 due");
    expect(bo).not.toContain("Low income");
  });

  it("gives an Admin everything the Treasurer has, without the Treasurer role", async () => {
    expect((await w.fetch(get("/dues", cookies.admin))).status).toBe(200);
    const s = await send({ intent: "settings", amount: "350", instructions: "Venmo" }, "admin");
    expect(s.status).toBe(302);
    const added = await send(
      { intent: "tier_save", tierName: "Build crew", amount: "100" },
      "admin",
    );
    expect(added.status).toBe(302);
    const build = (await t.db.select().from(duesTier)).find((x) => x.name === "Build crew");
    const paidRes = await send(
      {
        personId: ids.bo,
        status: "paid",
        tier: build?.id ?? "",
        amount: "",
        paidOn: "2027-02-01",
        method: "venmo",
      },
      "admin",
    );
    expect(paidRes.status).toBe(302);
    const [bo] = (await duesBoard(t.db)).filter((r) => r.personId === ids.bo);
    expect(bo).toMatchObject({ status: "paid", tierName: "Build crew", amountCents: 10000 });
    // Put back as it was for the tests below.
    await send({ intent: "tier_remove", tierId: build?.id ?? "" }, "admin");
    await send(
      { personId: ids.bo, status: "unpaid", tier: "", amount: "", paidOn: "", method: "venmo" },
      "admin",
    );
  });

  it("refuses tier changes from anyone but the Treasurer", async () => {
    const [tier] = await t.db.select().from(duesTier);
    for (const fields of <Array<Record<string, string>>>[
      { intent: "tier_save", tierId: "", tierName: "Mine", amount: "1" },
      { intent: "tier_remove", tierId: tier.id },
    ]) {
      expect((await send(fields, "lead")).status).toBe(403);
      expect((await send(fields, "amy")).status).toBe(403);
    }
    expect(await t.db.select().from(duesTier)).toHaveLength(1);
  });

  it("removes a tier and says who went back to the standard amount", async () => {
    const [tier] = await t.db.select().from(duesTier);
    const res = await send({ intent: "tier_remove", tierId: tier.id });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "1 camper is back on the standard amount",
    );
    expect(await (await w.fetch(get("/", cookies.amy))).text()).toContain("$350 due");
  });
});
