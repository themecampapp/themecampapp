// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole } from "~/db/schema";
import { instanceReserved, slugProblem } from "~/lib/reserved-slugs";
import { createTestDb, type TestDb } from "../helpers/db";
import { startPlatform } from "../helpers/platform";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Open-source plan, Unit 2.4: the instance's contact address, support community and reserved
// names come from its config, not the code. Here, an instance with no support community and
// its own contact address.
const NO_SUPPORT = { SUPPORT_URL: "", CONTACT_EMAIL: "help@camps.example.org" };

describe("reserved camp addresses", () => {
  it("add the instance's own names to the general list", () => {
    const hosted = instanceReserved({
      RESERVED_SLUGS: "themecamp, tca",
      RESERVED_PARTS: "themecampapp",
    });
    expect(slugProblem("tca", hosted)).toBe("slug_reserved");
    expect(slugProblem("my-themecampapp-fans", hosted)).toBe("slug_reserved");
    expect(slugProblem("burningman", hosted)).toBe("slug_reserved"); // the general list
    // Another instance doesn't reserve Theme Camp App's names.
    expect(slugProblem("tca", instanceReserved({}))).toBeNull();
    expect(slugProblem("themecamp")).toBeNull();
  });
});

describe("an instance without a support community", () => {
  let t: TestDb;
  let w: TestWorker;
  let admin: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t, NO_SUPPORT);
    const p = await invitePerson(t, "admin@example.com", { legalName: "Admin Person" });
    await t.db.insert(memberRole).values({ personId: p.id, role: "admin" });
    admin = await signIn(w, "admin@example.com");
    await t.client`update camp set created_in_console = true`;
    await t.client`update camp_settings set agreement_accepted_at = now()`;
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("leaves the community out of the Overview and the setup checklist", async () => {
    const home = await (await w.fetch(get("/", admin))).text();
    expect(home).toContain("Setting up your camp");
    expect(home).not.toContain("admin community");
    expect(home).not.toContain("discord.gg");
  });

  it("points the Admin guide's help and contact at the instance's own address", async () => {
    const guide = await (await w.fetch(get("/admin/guide", admin))).text();
    expect(guide).toContain("mailto:help@camps.example.org");
    expect(guide).toContain("help@camps.example.org");
    expect(guide).not.toContain("discord.gg");
    expect(guide).not.toContain("hello@themecamp");
  });

  it("leaves Discord off the sign-up thank-you page, and out of new Admins' invites", async () => {
    const platform = await startPlatform(t, "operator@example.com", NO_SUPPORT);
    try {
      const thanks = await (await platform.site("/signup/thanks")).text();
      expect(thanks).not.toContain("Discord");
      const res = await platform.consolePost("/ops/camps/new", {
        name: "Quiet Camp",
        slug: "quietcamp",
        adminName: "Quinn",
        adminEmail: "quinn@example.com",
        year: "2027",
      });
      await res.body?.cancel();
      const invite = platform.mail.find((m) => m.to === "quinn@example.com");
      expect(invite?.body).toContain("Write to help@camps.example.org.");
      expect(invite?.body).not.toContain("Discord");
    } finally {
      await platform.dispose();
    }
  });
});

// Open-source plan, Unit 3.5: everything a person sees names the instance from its config.
describe("an instance with its own name", () => {
  const NAMED = { PRODUCT_NAME: "Example Camps" };
  let t: TestDb;
  let w: TestWorker;
  let admin: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t, NAMED);
    const p = await invitePerson(t, "named@example.com", { legalName: "Named Admin" });
    await t.db.insert(memberRole).values({ personId: p.id, role: "admin" });
    admin = await signIn(w, "named@example.com");
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("names it in emails: the footer says who sent it through what", () => {
    const signInEmail = w.emails.at(-1);
    expect(signInEmail?.text).toContain("through Example Camps.");
    expect(`${signInEmail?.subject}\n${signInEmail?.text}`).not.toContain("Theme Camp App");
  });

  it("names it on the camp's pages, never the hosted service", async () => {
    for (const path of ["/", "/feedback", "/admin/support", "/admin/guide", "/admin/activity"]) {
      const html = await (await w.fetch(get(path, admin))).text();
      expect(html, path).toContain("Example Camps");
      expect(html, path).not.toContain("Theme Camp App");
    }
  });

  it("names it on the public site, the sign-up pages and the console", async () => {
    const platform = await startPlatform(t, "operator@example.com", NAMED);
    try {
      for (const path of ["/", "/signup", "/signup/thanks"]) {
        const html = await (await platform.site(path)).text();
        expect(html, path).toContain("Example Camps");
        expect(html, path).not.toContain("Theme Camp App");
      }
      // The legal pages' text is the hosted service's own (Unit 3.6); their frame isn't.
      const legal = await (await platform.site("/legal/terms")).text();
      expect(legal).toContain("<title>Terms of Service · Example Camps</title>");
      const ops = await (await platform.consoleGet("/ops")).text();
      expect(ops).toContain("Operator console · Example Camps");
    } finally {
      await platform.dispose();
    }
  });
});

// Open-source plan, Unit 3.6: each instance's legal pages and whether it has a pilot agreement.
describe("an instance with its own legal pages and no pilot agreement", () => {
  const OWN_LEGAL = {
    PRODUCT_NAME: "Example Camps",
    OPERATOR_NAME: "Example Org",
    CONTACT_EMAIL: "hello@camps.example.org",
    LEGAL_DIR: "templates",
    PILOT_AGREEMENT: "false",
  };
  let t: TestDb;
  let w: TestWorker;
  let admin: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t, OWN_LEGAL);
    const p = await invitePerson(t, "legal@example.com", { legalName: "Legal Admin" });
    await t.db.insert(memberRole).values({ personId: p.id, role: "admin" });
    admin = await signIn(w, "legal@example.com");
    // A camp created in the console, not yet agreed: hosted, its Admins would be stopped.
    await t.client`update camp set created_in_console = true`;
    await t.client`update camp_settings set agreement_accepted_at = null`;
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("doesn't stop Admins at a pilot agreement, or have one", async () => {
    const home = await w.fetch(get("/", admin));
    expect(home.status).toBe(200);
    await home.body?.cancel();
    const agreement = await w.fetch(get("/admin/agreement", admin));
    await agreement.body?.cancel();
    expect(agreement.status).toBe(404);
    const guide = await (await w.fetch(get("/admin/guide", admin))).text();
    expect(guide).not.toContain("/admin/agreement");
  });

  it("serves its own legal pages, filled in from its config, with working links", async () => {
    const platform = await startPlatform(t, "operator@example.com", OWN_LEGAL);
    try {
      const terms = await (await platform.site("/legal/terms")).text();
      expect(terms).toContain("Example Camps is run by Example Org");
      expect(terms).toContain("hello@camps.example.org");
      expect(terms).toContain("[your jurisdiction]");
      expect(terms).not.toContain("Kline Technology");
      expect(terms).not.toMatch(/\{(product|operator|contact)\}/);
      for (const doc of ["privacy", "data-handling"]) {
        expect(terms).toContain(`href="/legal/${doc}"`);
        expect((await platform.site(`/legal/${doc}`)).status, doc).toBe(200);
      }
      expect(terms).not.toContain('href="/legal/pilot-agreement"');
      const agreement = await platform.site("/legal/pilot-agreement");
      await agreement.body?.cancel();
      expect(agreement.status).toBe(404);
      const home = await (await platform.site("/")).text();
      expect(home).not.toContain("/legal/pilot-agreement");
      expect(home).toContain('href="/legal/terms"');
    } finally {
      await platform.dispose();
    }
  });
});
