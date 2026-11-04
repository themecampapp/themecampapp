// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  burn,
  campSettings,
  memberRole,
  participation,
  volunteerRole,
  volunteerSignup,
} from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #106: the elected positions are jobs that Leads fill, alongside the jobs members sign up
// for. The test camp is seeded with Yellow Balloon's elected jobs (Leads fill them, shown in the
// Yearbook's Who's who) and its sign-up jobs.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

async function jobId(title: string) {
  const [j] = await t.db.select().from(volunteerRole).where(eq(volunteerRole.title, title));
  return j.id;
}
async function isLead(personId: string) {
  const rows = await t.db
    .select()
    .from(memberRole)
    .where(
      and(
        eq(memberRole.personId, personId),
        eq(memberRole.role, "lead"),
        isNull(memberRole.revokedAt),
      ),
    );
  return rows.length > 0;
}
const send = (path: string, fields: Record<string, string>, who: string) =>
  w.fetch(post(path, fields, { cookie: cookie[who] }));
const page = async (path: string, who: string) => (await w.fetch(get(path, cookie[who]))).text();
const fill = async (title: string, personId: string, who = "lead") =>
  send("/volunteers", { intent: "add_person", roleId: await jobId(title), personId }, who);

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const [y27] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  const make = async (key: string, playaName: string, roles: Array<"lead" | "admin"> = []) => {
    const p = await invitePerson(t, `${key}@example.com`, {
      legalName: `${key} Person`,
      playaName,
    });
    ids[key] = p.id;
    for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[key] = await signIn(w, `${key}@example.com`);
    await w.fetch(get("/", cookie[key]));
    await t.db.insert(participation).values({ personId: p.id, burnId: y27.id, intent: "going" });
  };
  await make("admin", "Tulsa", ["admin"]);
  await make("lead", "Raven", ["lead"]);
  await make("sprout", "Sprout");
  await make("member", "Plain");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("jobs Leads fill", () => {
  it("come first on the jobs page, marked as filled by Leads", async () => {
    const html = await page("/volunteers", "lead");
    const at = ["Main camp lead", "Treasurer", "Decor", "Volunteer Coordinator"].map((title) =>
      html.indexOf(`>${title}<`),
    );
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain("Leads fill this job");
    expect(html).toContain("In Who&#x27;s who");
    const member = await page("/volunteer", "member");
    expect(member).toContain("Filled by Leads");
    expect(member).toContain("Main camp lead");
  });

  it("can't be taken or left by members themselves", async () => {
    const roleId = await jobId("Treasurer");
    const res = await send("/volunteer", { intent: "join", roleId }, "member");
    expect(await res.text()).toContain("Leads fill that job");
    expect(
      await t.db.select().from(volunteerSignup).where(eq(volunteerSignup.roleId, roleId)),
    ).toHaveLength(0);

    await fill("Treasurer", ids.member);
    const leave = await send("/volunteer", { intent: "leave", roleId }, "member");
    expect(await leave.text()).toContain("Leads fill that job");
    expect(
      await t.db.select().from(volunteerSignup).where(eq(volunteerSignup.roleId, roleId)),
    ).toHaveLength(1);
    await send("/volunteers", { intent: "remove_person", roleId, personId: ids.member }, "lead");
  });

  it("are filled by Leads, show in Who's who and on the person page, and give no access", async () => {
    expect((await fill("Events coordinator", ids.sprout)).status).toBe(302);
    await fill("Main camp lead", ids.admin);
    await fill("Main camp lead", ids.lead);
    expect(await isLead(ids.sprout)).toBe(false);
    expect((await w.fetch(get("/roster", cookie.sprout))).status).toBe(403);

    const dir = await page("/yearbook?view=directory", "member");
    expect(dir).toContain("Who&#x27;s who");
    expect(dir).toContain("Main camp lead:");
    expect(dir).toContain("Raven, Tulsa");
    expect(dir).toContain("Events coordinator");
    const person = await page(`/people/${ids.sprout}`, "admin");
    expect(person).toContain("Events coordinator");
    expect(person).not.toContain("Elected:");
  });

  it("leave Who's who when that box is unticked", async () => {
    const roleId = await jobId("Events coordinator");
    await send(
      "/volunteers",
      {
        intent: "update",
        roleId,
        title: "Events coordinator",
        slots: "2",
        commitment: "",
        description: "",
      },
      "lead",
    );
    const [job] = await t.db.select().from(volunteerRole).where(eq(volunteerRole.id, roleId));
    expect(job).toMatchObject({ selfSignup: false, showInYearbook: false });
    const dir = await page("/yearbook?view=directory", "member");
    expect(dir).not.toContain("Events coordinator");
    // Nor do members see who holds it on the jobs page: just how full it is.
    const jobs = await page("/volunteer", "member");
    expect(jobs).toContain("Events coordinator");
    expect(jobs).toContain(": 1 of 2 filled");
    expect(jobs).not.toContain("Sprout");
    await send(
      "/volunteers",
      {
        intent: "update",
        roleId,
        title: "Events coordinator",
        slots: "2",
        commitment: "",
        description: "",
        showInYearbook: "1",
      },
      "lead",
    );
    expect(await page("/yearbook?view=directory", "member")).toContain("Events coordinator");
    expect(await page("/volunteer", "member")).toContain("Sprout");
  });
});

describe("Make Lead", () => {
  it("is offered to Admins beside people who aren't Leads, and makes them one", async () => {
    const chip = (html: string, name: string) => {
      const at = html.indexOf(`>${name}</a>`);
      return html.slice(at, html.indexOf("</li>", at));
    };
    const html = await page("/volunteers", "admin");
    expect(chip(html, "Sprout")).toContain("Make Lead");
    expect(chip(html, "Raven")).not.toContain("Make Lead"); // a Lead already
    expect(chip(html, "Tulsa")).not.toContain("Make Lead"); // an Admin is a Lead too
    expect(await page("/volunteers", "lead")).not.toContain("Make Lead");
    // Who's a Lead reaches only Admins: it isn't in the page's data for anyone else.
    expect(html).toContain("isLead");
    expect(await page("/volunteers", "lead")).not.toContain("isLead");

    // Only Admins give roles: a Lead posting it directly is refused.
    const byLead = await send("/volunteers", { intent: "make_lead", personId: ids.sprout }, "lead");
    await byLead.body?.cancel();
    expect(await isLead(ids.sprout)).toBe(false);

    const res = await send("/volunteers", { intent: "make_lead", personId: ids.sprout }, "admin");
    expect(res.status).toBe(302);
    expect(await isLead(ids.sprout)).toBe(true);
    expect((await w.fetch(get("/roster", cookie.sprout))).status).toBe(200);
  });

  it("taking someone out of a job keeps them a Lead", async () => {
    await send(
      "/volunteers",
      { intent: "remove_person", roleId: await jobId("Events coordinator"), personId: ids.sprout },
      "lead",
    );
    expect(await isLead(ids.sprout)).toBe(true);
  });
});

describe("the camp's limit of jobs per member", () => {
  it("counts only jobs people picked themselves", async () => {
    await t.db.update(campSettings).set({ volunteerMaxRoles: 1 });
    // A Lead puts them in a sign-up job: it doesn't count against their own pick.
    await fill("Camp Cartographer", ids.member);
    const res = await send(
      "/volunteer",
      { intent: "join", roleId: await jobId("Volunteer Coordinator") },
      "member",
    );
    expect(res.status).toBe(302);
    // Now they've picked one, so a second pick is refused.
    const again = await send(
      "/volunteer",
      { intent: "join", roleId: await jobId("Logistics/Infrastructure Lead") },
      "member",
    );
    expect(await again.text()).toContain("as many jobs as this camp allows");
    await t.db.update(campSettings).set({ volunteerMaxRoles: null });
  });

  it("stops counting a pick once its job becomes one only Leads fill", async () => {
    await t.db.update(campSettings).set({ volunteerMaxRoles: 1 });
    const coordinator = await jobId("Volunteer Coordinator");
    await send(
      "/volunteers",
      {
        intent: "update",
        roleId: coordinator,
        title: "Volunteer Coordinator",
        slots: "1",
        commitment: "",
        description: "",
      },
      "lead",
    );
    // They can't leave it themselves now, so it mustn't use up their one pick.
    const res = await send(
      "/volunteer",
      { intent: "join", roleId: await jobId("Logistics/Infrastructure Lead") },
      "member",
    );
    expect(res.status).toBe(302);
    await t.db.update(campSettings).set({ volunteerMaxRoles: null });
  });
});

describe("elsewhere", () => {
  it("Leads have a Jobs link with the Lead tools; members don't", async () => {
    expect(await page("/", "lead")).toMatch(/href="\/volunteers"[^>]*>Jobs</);
    expect(await page("/", "member")).not.toContain('href="/volunteers"');
  });

  it("Admin → Positions goes to the jobs page", async () => {
    const res = await w.fetch(get("/admin/positions", cookie.admin));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/volunteers");
  });

  it("Who's who goes away while jobs are switched off", async () => {
    await t.db.update(campSettings).set({ featureVolunteer: false });
    expect(await page("/yearbook?view=directory", "member")).not.toContain("Who&#x27;s who");
    await t.db.update(campSettings).set({ featureVolunteer: true });
  });

  it("start empty in a new season, keeping the jobs, and come back when switching back", async () => {
    await send("/admin", { fromYear: "2027" }, "admin");
    const html = await page("/volunteers", "admin");
    expect(html).toContain("Manage 2028 jobs");
    expect(html).toContain("Main camp lead");
    expect(html).not.toContain(">Raven<");
    expect(await isLead(ids.sprout)).toBe(true); // Leads stay Leads
    await send("/admin", { intent: "switch", year: "2027" }, "admin");
    expect(await page("/volunteers", "admin")).toContain(">Raven<");
  });
});
