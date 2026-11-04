// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STARTERS } from "~/lib/data/starters.server";
import { slugProblem } from "~/lib/reserved-slugs";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { startPlatform } from "../helpers/platform";
import { get, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// R12, R13, R24, R30, R68: the operator creates a camp in the console; its first Admin accepts
// the pilot agreement and is walked through setup by the checklist; ready-made guides copy in.

const DUSTY = `https://dustyowls.${APP_HOST_SUFFIX}`;
const ADMIN = "owl@example.com";

let t: TestDb;
let w: TestWorker;
let platform: Awaited<ReturnType<typeof startPlatform>>;
let campId: string;
let admin: string;
let runtime: ReturnType<typeof postgres>;

beforeAll(async () => {
  t = await createTestDb();
  platform = await startPlatform(t);
  w = await startWorker(t);
  runtime = postgres(t.runtimeUrl, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await runtime.end();
  await platform.dispose();
  await w.dispose();
  await t.drop();
});

const create = (fields: Partial<Record<string, string>>) =>
  platform.consolePost("/ops/camps/new", {
    name: "Dusty Owls",
    slug: "dustyowls",
    adminName: "Olive Owl",
    adminEmail: ADMIN,
    year: "2027",
    ...fields,
  } as Record<string, string>);
const page = async (path: string, cookie = admin) => w.fetch(get(path, cookie, DUSTY));
const html = async (path: string, cookie = admin) => (await page(path, cookie)).text();
const send = (path: string, fields: Record<string, string>, cookie = admin) =>
  w.fetch(post(path, fields, { cookie, base: DUSTY }));
// As the camp: its rows, through row-level security (as the camp Worker's role; the owner
// would skip it).
const asCamp = async <T>(query: string): Promise<T[]> =>
  runtime.begin(async (tx) => {
    await tx`select set_config('app.camp_id', ${campId}, true)`;
    return tx.unsafe(query) as unknown as T[];
  }) as Promise<T[]>;

describe("camp addresses (R13)", () => {
  it("are lowercase letters, digits and inner hyphens, and not reserved", () => {
    for (const ok of ["dustyowls", "camp-42", "ab"]) expect(slugProblem(ok), ok).toBeNull();
    for (const bad of ["Dusty Owls", "DustyOwls", "-owls", "owls-", "a", "dusty--owls", "é"]) {
      expect(slugProblem(bad), bad).toBe("slug_format");
    }
    for (const reserved of ["ops", "www", "admin", "burningman", "the-burningman-camp", "demo"]) {
      expect(slugProblem(reserved), reserved).toBe("slug_reserved");
    }
  });
});

describe("creating a camp in the console (R12)", () => {
  it("refuses reserved, malformed and taken addresses, and creates nothing", async () => {
    for (const [slug, says] of [
      ["ops", "reserved"],
      ["www", "reserved"],
      ["burningman", "reserved"],
      ["Dusty Owls", "lowercase"],
      ["testcamp", "already has that address"],
    ]) {
      const res = await create({ slug });
      expect(res.status, slug).toBe(200);
      expect(await res.text(), slug).toContain(says);
    }
    expect(await t.client`select 1 from camp where slug <> 'testcamp'`).toHaveLength(0);
    expect(platform.mail).toHaveLength(0);
    expect(platform.discord).toHaveLength(0);
  });

  it("makes the camp, its season and first Admin, invites them, and logs it", async () => {
    const res = await create({});
    expect(res.status).toBe(302);
    // Issue #32: the operator's Discord hears of it, without the first Admin's details.
    expect(platform.discord).toEqual([
      `⛺ New camp: **Dusty Owls** (<https://dustyowls.${APP_HOST_SUFFIX}>), 2027 season`,
    ]);
    const [c] = await t.client`
      select id, name, created_in_console from camp where slug = 'dustyowls'`;
    campId = c.id;
    expect(c.created_in_console).toBe(true);
    expect(res.headers.get("location")).toContain(`/ops/camps/${campId}`);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(`${ADMIN} is invited`);

    const [s] = await asCamp<Record<string, unknown>>(
      "select current_year, feature_dues, feature_join, feature_yearbook, feature_saps, feature_volunteer from camp_settings",
    );
    // R20's defaults for a new camp.
    expect(s).toEqual({
      current_year: 2027,
      feature_dues: true,
      feature_join: true,
      feature_yearbook: true,
      feature_saps: false,
      feature_volunteer: false,
    });
    const roles = await asCamp<{ role: string }>(
      "select r.role from member_role r join person p on p.id = r.person_id order by 1",
    );
    expect(roles.map((r) => r.role)).toEqual(["admin", "lead", "treasurer"]);
    const invites = await asCamp<{ email: string; status: string }>(
      "select email, status from invite",
    );
    expect(invites).toEqual([{ email: ADMIN, status: "pending" }]);
    const audits = await asCamp<{ action: string; actor_type: string }>(
      "select action, actor_type from audit_log",
    );
    expect(audits).toEqual([{ action: "camp_created", actor_type: "operator" }]);
    const [logged] = await t.client`
      select action from operator_log where subject_camp_id = ${campId}`;
    expect(logged.action).toBe("camp_created");

    expect(platform.mail).toHaveLength(1);
    const [m] = platform.mail;
    expect(m.to).toBe(ADMIN);
    expect(m.subject).toBe("You're invited to set up Dusty Owls on Theme Camp App");
    expect(m.body).toContain(`${DUSTY}/sign-in?email=owl%40example.com`);
  });

  it("lists the new camp, with a way to make another", async () => {
    const list = await (await platform.consoleGet("/ops")).text();
    expect(list).toContain("Dusty Owls");
    expect(list).toContain('href="/ops/camps/new"');
  });
});

describe("the pilot agreement (R68)", () => {
  it("is where the first Admin lands, and every other page sends them back to it", async () => {
    admin = await signIn(w, ADMIN, DUSTY);
    expect(admin).toContain("session");
    for (const path of ["/", "/admin/settings", "/people", "/guide-editor", "/rsvp"]) {
      const res = await page(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/admin/agreement");
      await res.text();
    }
    const text = await html("/admin/agreement");
    expect(text).toContain("A free pilot, with best-effort support");
    expect(text).toContain("I&#x27;ve read this and accept it on behalf of Dusty Owls.");
  });

  it("is recorded once accepted, and the app opens up", async () => {
    const res = await send("/admin/agreement", { agree: "on" });
    expect(res.status).toBe(302);
    await res.text();
    const [s] = await asCamp<{ agreement_version: string; agreement_accepted_by: string }>(
      "select agreement_version, agreement_accepted_by from camp_settings",
    );
    expect(s.agreement_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [me] = await asCamp<{ id: string }>(`select id from person where email = '${ADMIN}'`);
    expect(s.agreement_accepted_by).toBe(me.id);
    expect(
      await asCamp("select 1 from audit_log where action = 'pilot_agreement_accepted'"),
    ).toHaveLength(1);
    expect((await page("/admin/settings")).status).toBe(200);
    expect(await html("/admin/agreement")).toContain("Accepted for Dusty Owls by Olive Owl");
  });

  it("isn't asked of a camp that wasn't created in the console", async () => {
    // The test camp (like Yellow Balloon and staging's sandbox) was set up by hand.
    const [c] = await t.client`select created_in_console from camp where slug = 'testcamp'`;
    expect(c.created_in_console).toBe(false);
  });
});

describe("the setup checklist (R24)", () => {
  const progress = (text: string) => /(\d) of 9 done/.exec(text)?.[1];

  it("shows the Admin what's left, each item linking to where it's done", async () => {
    const home = await html("/");
    expect(home).toContain("Setting up your camp");
    expect(progress(home)).toBe("0");
    for (const to of [
      "/admin/settings",
      "/admin/features",
      "/admin/roles",
      "/dues",
      "/dates",
      "/guide-editor",
    ]) {
      expect(home).toContain(`href="${to}"`);
    }
    // Issue #82: the Discord server, opened in a new tab.
    expect(home).toMatch(
      /<a href="https:\/\/discord\.gg\/support-test" target="_blank" rel="noopener noreferrer"[^>]*>Join the Theme Camp App admin community<\/a>/,
    );
  });

  it("never shows to members", async () => {
    await asCamp(
      `insert into person (legal_name, email) values ('Mo Member', 'mo@example.com');
       insert into invite (person_id, email, status)
         select id, email, 'pending' from person where email = 'mo@example.com'`,
    );
    const member = await signIn(w, "mo@example.com", DUSTY);
    expect(await html("/", member)).not.toContain("Setting up your camp");
    const res = await send("/setup-checklist", { intent: "reopen" }, member);
    expect(await res.text()).toContain("Only an Admin can do that");
    const opened = await send("/setup-checklist", { intent: "community" }, member);
    expect(await opened.text()).toContain("have access to do that");
  });

  it("can be hidden, and brought back from the Admin page", async () => {
    await (await send("/setup-checklist", { intent: "dismiss" })).text();
    expect(await html("/")).not.toContain("Setting up your camp");
    expect(await html("/admin")).toContain("Show the setup checklist on the home page again");
    await (await send("/setup-checklist", { intent: "reopen" })).text();
    expect(await html("/")).toContain("Setting up your camp");
  });

  it("ticks each item off as it's done, and goes away when all are", async () => {
    // "Add your people" is already done: Mo was added above.
    expect(progress(await html("/"))).toBe("1");
    await asCamp("update camp_settings set contact_email = 'owls@example.com'");
    expect(progress(await html("/"))).toBe("2");
    await (await send("/admin/features", { on: "dues" })).text();
    expect(progress(await html("/"))).toBe("3");
    // Issue #93: "These look right" on Admin → Roles.
    expect(await html("/admin/roles")).toContain("These look right");
    await (await send("/admin/roles", {})).text();
    expect(progress(await html("/"))).toBe("4");
    expect(await html("/admin/roles")).not.toContain("These look right");
    await asCamp("update burn set dues_amount_cents = 15000");
    expect(progress(await html("/"))).toBe("5");
    await asCamp(
      "insert into key_date (burn_id, label, date) select id, 'Build starts', '2027-08-20' from burn",
    );
    expect(progress(await html("/"))).toBe("6");

    // A guide: copied from a starter, then published.
    const copied = await send("/guide-editor", { intent: "copy_starter", slug: "welcome" });
    expect(copied.status).toBe(302);
    await copied.text();
    const [g] = await asCamp<{ id: string }>("select id from guide where slug = 'welcome'");
    await (await send("/guide-editor", { intent: "publish", id: g.id })).text();
    expect(progress(await html("/"))).toBe("7");

    // Mo has already signed in, so the invite goes to someone new.
    await asCamp("insert into person (legal_name, email) values ('Nia New', 'nia@example.com')");
    const [nia] = await asCamp<{ id: string }>(
      "select id from person where email = 'nia@example.com'",
    );
    const invited = await send(`/people/${nia.id}`, { intent: "invite" });
    expect(invited.status).toBe(302);
    await invited.text();
    expect(progress(await html("/"))).toBe("8");

    // Issue #82: opening the Discord link from the checklist ticks it off for the camp.
    const opened = await send("/setup-checklist", { intent: "community" });
    expect(opened.status).toBe(200);
    await opened.text();
    const [s] = await asCamp<{ at: Date | null }>(
      "select community_joined_at as at from camp_settings",
    );
    expect(s.at).not.toBeNull();
    expect(await html("/")).not.toContain("Setting up your camp");
    // Opening it again keeps the first time.
    await (await send("/setup-checklist", { intent: "community" })).text();
    const [again] = await asCamp<{ at: Date | null }>(
      "select community_joined_at as at from camp_settings",
    );
    expect(again.at).toEqual(s.at);
  });
});

describe("the starter guide library (R30)", () => {
  it("has the seven starters at the addresses the app links to, with no Yellow Balloon in them", () => {
    expect(STARTERS.map((s) => s.slug)).toEqual([
      "welcome",
      "tickets-stewards-sale",
      "arrival-build-strike",
      "dues",
      "sap",
      "volunteer",
      "lead-handbook",
    ]);
    for (const s of STARTERS) {
      expect(`${s.title}\n${s.summary}\n${s.body}`, s.slug).not.toMatch(
        /yellow[\s_-]?balloon|\byb\b|curtis/i,
      );
    }
    expect(STARTERS.find((s) => s.slug === "lead-handbook")?.visibility).toBe("leads");
  });

  it("copies into this camp only, as a draft, and not twice", async () => {
    const before = await t.client`
      select count(*)::int as n from guide where camp_id <> ${campId}`;
    const res = await send("/guide-editor", { intent: "copy_starter", slug: "dues" });
    expect(res.status).toBe(302);
    await res.text();
    const [d] = await asCamp<{ published: boolean; title: string }>(
      "select published, title from guide where slug = 'dues'",
    );
    expect(d).toEqual({ published: false, title: "Camp dues" });
    const after = await t.client`
      select count(*)::int as n from guide where camp_id <> ${campId}`;
    expect(after[0].n).toBe(before[0].n);

    const again = await send("/guide-editor", { intent: "copy_starter", slug: "dues" });
    expect(await again.text()).toContain("already has a guide at that address");
    const editor = await html("/guide-editor");
    expect(editor).toContain("You have /guides/dues");
    expect(editor).toContain("Start from a ready-made guide");
  });
});
