// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, burn, memberRole, participation, sapPass } from "~/db/schema";
import { currentYear } from "~/lib/data/participation.server";
import { attendanceReview } from "~/lib/data/season.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

async function attended(personId: string, year: number) {
  const [b] = await t.db.select().from(burn).where(eq(burn.year, year));
  const [row] = await t.db
    .select({ attended: participation.attended })
    .from(participation)
    .where(and(eq(participation.personId, personId), eq(participation.burnId, b.id)));
  return row?.attended ?? null;
}

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const [y27] = await t.db.select().from(burn).where(eq(burn.year, 2027));

  const make = async (key: string, legalName: string, roles: Array<"lead" | "admin"> = []) => {
    const p = await invitePerson(t, `${key}@example.com`, { legalName, playaName: legalName });
    ids[key] = p.id;
    for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[key] = await signIn(w, `${key}@example.com`);
    await w.fetch(get("/", cookie[key]));
  };
  await make("admin", "Ada Admin", ["admin"]);
  await make("lead", "Lee Lead", ["lead"]);
  await make("member", "Mo Member");

  for (const [key, intent] of [
    ["going1", "going"],
    ["going2", "going"],
    ["leaning", "leaning_yes"],
    ["maybe", "leaning_no"],
  ] as const) {
    const p = await invitePerson(t, `${key}@example.com`, { legalName: key, playaName: key });
    ids[key] = p.id;
    await t.db.insert(participation).values({ personId: p.id, burnId: y27.id, intent });
  }
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("the Admin role", () => {
  it("can do everything a Lead and a Treasurer can", async () => {
    expect((await w.fetch(get("/roster", cookie.admin))).status).toBe(200);
    expect((await w.fetch(get("/dues", cookie.admin))).status).toBe(200);
    const home = await (await w.fetch(get("/", cookie.admin))).text();
    expect(home).toContain("You&#x27;re an Admin.");
    expect(home).toContain('href="/admin"');
  });

  it("keeps the Admin page from Leads and Members", async () => {
    for (const who of ["lead", "member"]) {
      expect((await w.fetch(get("/admin", cookie[who]))).status).toBe(403);
    }
    expect(await (await w.fetch(get("/", cookie.lead))).text()).not.toContain('href="/admin"');
  });

  it("can only be granted by an Admin, and never removed from the last Admin", async () => {
    const byLead = await w.fetch(
      post(`/people/${ids.lead}`, { intent: "grant", role: "admin" }, { cookie: cookie.lead }),
    );
    expect(await byLead.text()).toContain("Only an Admin can do that.");
    const self = await w.fetch(
      post(`/people/${ids.admin}`, { intent: "revoke", role: "admin" }, { cookie: cookie.admin }),
    );
    expect(await self.text()).toContain("no active Admin");

    await w.fetch(
      post(
        `/people/${ids.lead}`,
        { intent: "grant", role: "admin", confirmed: "1" },
        { cookie: cookie.admin },
      ),
    );
    expect((await w.fetch(get("/admin", cookie.lead))).status).toBe(200);
    await w.fetch(
      post(`/people/${ids.lead}`, { intent: "revoke", role: "admin" }, { cookie: cookie.admin }),
    );
    expect((await w.fetch(get("/admin", cookie.lead))).status).toBe(403);
  });
});

describe("rolling over to a new season", () => {
  it("reviews everyone Going (ticked) or Leaning yes (unticked)", async () => {
    const review = await attendanceReview(t.db);
    const byName = Object.fromEntries(review.map((r) => [r.name, r.came]));
    expect(byName).toEqual({ going1: true, going2: true, leaning: false });
    const page = await (await w.fetch(get("/admin", cookie.admin))).text();
    expect(page).toContain("Roll over to 2028");
    expect(page).toContain("going1");
  });

  it("sets up a SAP for 2027 (request, pass, approval) to check the rollover resets it", async () => {
    const [y27] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await t.db
      .update(participation)
      .set({ sapRequested: true, sapDate: "2027-08-24" })
      .where(and(eq(participation.personId, ids.going1), eq(participation.burnId, y27.id)));
    await w.fetch(
      post(
        "/admin/saps",
        { intent: "add", date: "2027-08-24", serials: "ROLL-1" },
        { cookie: cookie.admin },
      ),
    );
    const [pass] = await t.db.select().from(sapPass).where(eq(sapPass.serial, "ROLL-1"));
    const [pa] = await t.db
      .select()
      .from(participation)
      .where(and(eq(participation.personId, ids.going1), eq(participation.burnId, y27.id)));
    await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "going1", passId: pass.id, day: "" },
        { cookie: cookie.admin },
      ),
    );
    const html = await (await w.fetch(get("/saps", cookie.admin))).text();
    expect(html).toContain("pass ROLL-1");
  });

  it("records who came, creates the next season, and switches the whole app to it", async () => {
    const res = await w.fetch(
      post("/admin", { fromYear: "2027", came: ids.going1 }, { cookie: cookie.admin }),
    );
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain(
      "Rolled over to 2028. Recorded 1 camper as having come and 2 as not.",
    );
    expect(await currentYear(t.db)).toBe(2028);
    expect(await attended(ids.going1, 2027)).toBe(true);
    expect(await attended(ids.going2, 2027)).toBe(false);
    expect(await attended(ids.leaning, 2027)).toBe(false);
    expect(await attended(ids.maybe, 2027)).toBeNull();
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, "season_rolled_over"));
    expect(a.after).toMatchObject({ year: 2028, came: 1, didNotCome: 2 });

    // Each person's History shows who marked them; Admin → Activity shows the rollover.
    const going1 = await (await w.fetch(get(`/people/${ids.going1}`, cookie.admin))).text();
    expect(going1).toMatch(
      /Camp year 2027 set to Came \(season rollover\)[\s\S]{0,200}by [\s\S]{0,20}<a[^>]*>Ada Admin<\/a>/,
    );
    const activity = await (await w.fetch(get("/admin/activity?area=season", cookie.admin))).text();
    expect(activity).toContain("Rolled the season over: 2027 → 2028 (1 came, 2 didn&#x27;t)");
    expect(activity).not.toContain("Camp year 2027 set to");
    expect((await w.fetch(get("/admin/activity", cookie.lead))).status).toBe(403);

    // The app now plans 2028: everyone's RSVP is blank, and 2027 is a past Yearbook.
    const home = await (await w.fetch(get("/", cookie.member))).text();
    expect(home).toContain("2028 RSVP");
    expect(home).toContain("RSVP for 2028");
    expect(await (await w.fetch(get("/roster", cookie.admin))).text()).toContain("2028 roster");
    expect((await w.fetch(get("/yearbook/2027", cookie.member))).status).toBe(200);
    // Returning-camper invites now mean "came in 2027".
    const invite = await (await w.fetch(get("/people/invite", cookie.admin))).text();
    expect(invite).toContain("came in 2027");

    // A new RSVP lands in 2028.
    await w.fetch(post("/rsvp", { intent: "going" }, { cookie: cookie.member }));
    expect(await (await w.fetch(get("/", cookie.member))).text()).toContain("Going");
  });

  it("starts Setup Access Passes fresh: no requests, passes or SAP days for the new year", async () => {
    const saps = await (await w.fetch(get("/saps", cookie.admin))).text();
    expect(saps).not.toContain("going1");
    expect(saps).not.toContain("ROLL-1");
    expect(saps).toContain("No passes in stock yet");
    const admin = await (await w.fetch(get("/admin/saps", cookie.admin))).text();
    expect(admin).toContain("None yet");
    expect(admin).not.toContain("ROLL-1");
    const rsvp = await (await w.fetch(get("/rsvp", cookie.member))).text();
    expect(rsvp).toContain("haven&#x27;t been announced yet");
    const [y28] = await t.db.select().from(burn).where(eq(burn.year, 2028));
    expect(y28.sapDays).toEqual([]);
  });

  it("refuses a second rollover from the same year (a double click)", async () => {
    const res = await w.fetch(
      post("/admin", { fromYear: "2027", came: ids.going2 }, { cookie: cookie.admin }),
    );
    expect(await res.text()).toContain("The season has already changed");
    expect(await currentYear(t.db)).toBe(2028);
    expect(await attended(ids.going2, 2027)).toBe(false);
  });

  it("can switch back, keeping recorded attendance", async () => {
    const res = await w.fetch(
      post("/admin", { intent: "switch", year: "2027" }, { cookie: cookie.admin }),
    );
    expect(res.status).toBe(302);
    expect(await currentYear(t.db)).toBe(2027);
    expect(await attended(ids.going1, 2027)).toBe(true);
    expect(await (await w.fetch(get("/", cookie.member))).text()).toContain("2027 RSVP");
    // 2027's SAP data was kept, not deleted.
    expect(await (await w.fetch(get("/saps", cookie.admin))).text()).toContain("pass ROLL-1");
    // Switching to a season that doesn't exist is refused.
    const bad = await w.fetch(
      post("/admin", { intent: "switch", year: "2099" }, { cookie: cookie.admin }),
    );
    expect(await bad.text()).toContain("doesn&#x27;t exist");
  });

  it("refuses rollover and switching to non-Admins", async () => {
    for (const body of [{ fromYear: "2027" }, { intent: "switch", year: "2028" }] as Array<
      Record<string, string>
    >) {
      const res = await w.fetch(post("/admin", body, { cookie: cookie.lead }));
      expect(res.status).toBe(403);
    }
    expect(await currentYear(t.db)).toBe(2027);
  });
});
