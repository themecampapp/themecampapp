// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appSetting,
  auditLog,
  campSettings,
  memberRole,
  volunteerRole,
  volunteerSignup,
} from "~/db/schema";
import { PAGE_TEXTS } from "~/lib/page-text";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #56: page wording each camp words its own way; issue #29: volunteer instructions and
// the most roles per member.

let t: TestDb;
let z: Zulu;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

const page = async (path: string, who: string) => (await w.fetch(get(path, cookie[who]))).text();
const send = async (path: string, fields: Record<string, string>, who = "admin") => {
  const res = await w.fetch(post(path, fields, { cookie: cookie[who] }));
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
};
const role = async (title: string) =>
  (await t.db.select().from(volunteerRole).where(eq(volunteerRole.title, title)))[0];

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  await t.db.update(campSettings).set({ featureVolunteer: true, featureJoin: true });
  const make = async (key: string, roles: Array<"lead" | "admin"> = []) => {
    const p = await invitePerson(t, `${key}@example.com`, {
      legalName: `${key} Person`,
      playaName: key,
    });
    ids[key] = p.id;
    for (const r of roles) await t.db.insert(memberRole).values({ personId: p.id, role: r });
    cookie[key] = await signIn(w, `${key}@example.com`);
    await w.fetch(get("/", cookie[key]));
  };
  await make("admin", ["admin"]);
  await make("lead", ["lead"]);
  await make("amy");
  for (const title of ["Kitchen", "Build", "Strike"]) {
    await t.db.insert(volunteerRole).values({ title, slots: 5 });
  }
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`delete from app_setting where key like 'page_text:%'`;
  await t.client`truncate volunteer_signup`;
  await t.db.update(campSettings).set({ volunteerMaxRoles: null, featureVolunteer: true });
});

describe("page wording (issue #56)", () => {
  it("shows the defaults, with no camp's own wording in them", async () => {
    const vol = await page("/volunteer", "amy");
    expect(vol).toContain("Camp runs on volunteers. Everyone signs up for at least one job.");
    for (const t of PAGE_TEXTS) expect(t.default).not.toMatch(/recovery|sober|yellow balloon/i);
    const join = await (await w.fetch(get("/join"))).text();
    expect(join).toContain("Burn experience, what draws you to the camp, questions.");
    expect(join).not.toContain("recovery");
  });

  it("lets an Admin put the camp's own instructions on the Volunteer page and home page", async () => {
    const saved = await send("/admin/wording", {
      key: "volunteer_instructions",
      text: "At {camp}, pick 2 or more roles for {year}. Details: https://example.com/vol.",
    });
    expect(saved.status).toBe(302);
    const vol = await page("/volunteer", "amy");
    expect(vol).toContain("At Test Camp, pick 2 or more roles for 2027. Details: ");
    expect(vol).toContain('href="https://example.com/vol"');
    expect(await page("/", "amy")).toContain("At Test Camp, pick 2 or more roles for 2027.");
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, "page_text_saved"));
    expect(a.after).toMatchObject({ name: "Volunteer instructions" });
  });

  it("takes them off the home page once the member has a role", async () => {
    await send("/admin/wording", { key: "volunteer_instructions", text: "Pick two, please." });
    await t.db.insert(volunteerSignup).values({
      burnId: (await t.client`select id from burn where year = 2027`)[0].id,
      roleId: (await role("Kitchen")).id,
      personId: ids.amy,
    });
    expect(await page("/", "amy")).not.toContain("Pick two, please.");
  });

  it("refuses HTML, unknown placeholders, http links and empty required text", async () => {
    for (const [text, why] of [
      ["<b>Bold</b>", "Plain text only"],
      ["Due {date}", "isn&#x27;t something the app can fill in"],
      ["See http://example.com", "Links must start with https://"],
      ["   ", "can&#x27;t be empty"],
    ]) {
      const res = await send("/admin/wording", { key: "volunteer_instructions", text });
      expect(res.html, text).toContain(why);
    }
    expect(
      await t.db
        .select()
        .from(appSetting)
        .where(eq(appSetting.key, "page_text:volunteer_instructions")),
    ).toHaveLength(0);
  });

  it("lets an optional text be emptied, which hides it", async () => {
    await send("/admin/wording", { key: "join_note_hint", text: "" });
    const join = await (await w.fetch(get("/join"))).text();
    expect(join).not.toContain("Burn experience, what draws you");
  });

  it("goes back to the default on reset, and audits it", async () => {
    await send("/admin/wording", { key: "volunteer_instructions", text: "Ours." });
    await send("/admin/wording", { key: "volunteer_instructions", intent: "reset" });
    expect(await page("/volunteer", "amy")).toContain("Camp runs on volunteers.");
    const resets = await t.db.select().from(auditLog).where(eq(auditLog.action, "page_text_reset"));
    expect(resets.length).toBeGreaterThan(0);
  });

  it("is for Admins only, and hides texts for switched-off features", async () => {
    const lead = await send(
      "/admin/wording",
      { key: "volunteer_instructions", text: "Mine" },
      "lead",
    );
    expect(lead.status).toBe(403);
    expect(await page("/admin/wording", "admin")).toContain("Volunteer instructions");
    await t.db.update(campSettings).set({ featureVolunteer: false });
    expect(await page("/admin/wording", "admin")).not.toContain("Volunteer instructions");
  });

  it("keeps each camp's wording to itself", async () => {
    await t.client`insert into app_setting (camp_id, key, value)
      values (${z.campId}, 'page_text:volunteer_instructions', '"Zzb only"')`;
    expect(await page("/volunteer", "amy")).not.toContain("Zzb only");
  });
});

describe("every page's wording", () => {
  // Each text, on the page that shows it, for someone who can see it there.
  const SHOWN: Array<[key: string, path: string, who: string]> = [
    ["join_intro", "/join", ""],
    ["rsvp_intro", "/rsvp", "amy"],
    ["rsvp_sap_hint", "/rsvp", "amy"],
    ["tickets_intro", "/tickets/request", "amy"],
    ["tickets_count_hint", "/tickets/request", "amy"],
    ["dues_timing", "/", "amy"],
    ["yearbook_card", "/", "amy"],
    ["yearbook_intro", "/yearbook?view=photos", "amy"],
    ["profile_photo", "/profile", "amy"],
    ["profile_email_hint", "/profile", "amy"],
  ];

  beforeAll(async () => {
    await t.db
      .update(campSettings)
      .set({ featureSaps: true, featureDues: true, featureYearbook: true });
    await t.client`update burn set dues_amount_cents = 25000 where year = 2027`;
    const [burn] = await t.client`select id from burn where year = 2027`;
    await t.client`insert into participation (camp_id, person_id, burn_id, intent)
      values (${t.campId}, ${ids.amy}, ${burn.id}, 'going') on conflict do nothing`;
  });

  it("covers every text in the list", () => {
    const keys = new Set([
      ...SHOWN.map(([k]) => k),
      "volunteer_instructions",
      "join_note_hint",
      "tickets_locked",
    ]);
    expect([...keys].sort()).toEqual(PAGE_TEXTS.map((t) => t.key).sort());
  });

  it.each(SHOWN)("shows the camp's %s on %s", async (key, path, who) => {
    const text = `Our own words for ${key} at {camp}`;
    expect((await send("/admin/wording", { key, text })).status).toBe(302);
    const html = who ? await page(path, who) : await (await w.fetch(get(path))).text();
    expect(html).toContain(`Our own words for ${key} at Test Camp`);
  });

  it("shows the locked-requests wording, then what the member asked for", async () => {
    await send("/admin/wording", { key: "tickets_locked", text: "Closed: Leads are buying now." });
    await t.client`update burn set ticket_requests_locked = true where year = 2027`;
    try {
      expect(await page("/tickets/request", "amy")).toContain(
        "Closed: Leads are buying now. Ask a Lead if you still need a ticket.",
      );
    } finally {
      await t.client`update burn set ticket_requests_locked = false where year = 2027`;
    }
  });

  it("keeps the app's own privacy wording after a camp's text", async () => {
    await send("/admin/wording", { key: "yearbook_intro", text: "Our people." });
    await send("/admin/wording", { key: "profile_photo", text: "Smile!" });
    expect(await page("/yearbook?view=photos", "amy")).toContain("Members only.");
    expect(await page("/profile", "amy")).toContain("members-only Yearbook");
  });

  it("moved the join page's introduction out of Settings", async () => {
    const settings = await page("/admin/settings", "admin");
    expect(settings).not.toContain('name="joinIntro"');
    expect(settings).toContain('href="/admin/wording"');
  });
});

describe("most jobs per member (issue #29)", () => {
  const join = async (title: string, who = "amy") =>
    send("/volunteer", { intent: "join", roleId: (await role(title)).id, title }, who);
  const mine = async () =>
    (await t.db.select().from(volunteerSignup).where(eq(volunteerSignup.personId, ids.amy))).length;

  it("lets an Admin set it, with the instructions, next to the roles", async () => {
    const res = await send("/volunteers", {
      intent: "member_rules",
      instructions: "Take two roles.",
      max: "2",
    });
    expect(res.status).toBe(302);
    const [s] = await t.db
      .select({ max: campSettings.volunteerMaxRoles })
      .from(campSettings)
      .where(eq(campSettings.campId, t.campId));
    expect(s.max).toBe(2);
    const vol = await page("/volunteer", "amy");
    expect(vol).toContain("Take two roles.");
    expect(vol).toContain("You can sign up for up to 2 jobs yourself.");
    expect(await page("/volunteers", "lead")).toContain("Members can sign up for up to 2 jobs each.");
  });

  it("stops a member at the limit, but not a Lead adding them", async () => {
    await t.db.update(campSettings).set({ volunteerMaxRoles: 2 });
    expect((await join("Kitchen")).status).toBe(302);
    expect((await join("Build")).status).toBe(302);
    const third = await join("Strike");
    expect(third.html).toContain("as many jobs as this camp allows");
    expect(await mine()).toBe(2);
    expect(await page("/volunteer", "amy")).toContain("You&#x27;re at the limit of 2 jobs.");
    const byLead = await send(
      "/volunteers",
      { intent: "add_person", roleId: (await role("Strike")).id, personId: ids.amy },
      "lead",
    );
    expect(byLead.status).toBe(302);
    expect(await mine()).toBe(3);
  });

  it("holds when two sign-ups arrive at once", async () => {
    await t.db.update(campSettings).set({ volunteerMaxRoles: 1 });
    await Promise.all([join("Kitchen"), join("Build")]);
    expect(await mine()).toBe(1);
  });

  it("is Admin-only to change, and must be 1 to 20 or blank", async () => {
    const lead = await send(
      "/volunteers",
      { intent: "member_rules", instructions: "x", max: "3" },
      "lead",
    );
    expect(lead.html).toContain("Admin");
    const bad = await send("/volunteers", { intent: "member_rules", instructions: "Ok", max: "0" });
    expect(bad.html).toContain("whole number from 1 to 20");
    await send("/volunteers", { intent: "member_rules", instructions: "Ok", max: "" });
    const [s] = await t.db
      .select({ max: campSettings.volunteerMaxRoles })
      .from(campSettings)
      .where(and(eq(campSettings.campId, t.campId)));
    expect(s.max).toBeNull();
  });
});
