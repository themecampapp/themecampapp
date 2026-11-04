// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { participation, person } from "~/db/schema";
import { campDb, createClients, endClients } from "~/lib/db.server";
import { DEMO_LEAD_ID } from "~/lib/demo";
import { inCamp } from "~/lib/files.server";
import { resetDemoCamp } from "../../scripts/lib/demo-data";
import { demoFiles } from "../../scripts/lib/demo-files";
import { APP_HOST_SUFFIX, APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, post, startWorker, type TestWorker } from "../helpers/worker";

// R67: the public demo camp. Anyone can look around as its Lead; nothing is ever saved, no
// email is sent, no file is stored, and a demo visit means nothing at any other camp.

const DEMO = `https://demo.${APP_HOST_SUFFIX}`;

let t: TestDb;
// Like the seed script itself: a plain client (the tests' own one is drizzle's, which encodes
// JSON differently and once hid a double-encoding bug).
let plain: ReturnType<typeof postgres>;
let w: TestWorker;
let demoId: string;
let cookie: string;

beforeAll(async () => {
  t = await createTestDb();
  plain = postgres(t.url, { max: 1, onnotice: () => {} });
  demoId = await resetDemoCamp(plain, { now: new Date("2026-10-01T12:00:00Z") });
  w = await startWorker(t);
});
afterAll(async () => {
  await plain.end();
  await w.dispose();
  await t.drop();
});

const page = (path: string, c = cookie, base = DEMO) => w.fetch(get(path, c, base));
const counts = async () =>
  (await t.client`select count(*)::int as n from participation where camp_id = ${demoId}`)[0].n;

describe("the demo camp", () => {
  it("lets anyone in, as its Lead, with a banner", async () => {
    const first = await page("/", "");
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/demo/enter");
    await first.text();
    // The way in asks which role to view the camp as (tests/demo/roles.test.ts).
    const chooser = await page("/demo/enter", "");
    expect(chooser.status).toBe(200);
    expect(await chooser.text()).toContain('href="/demo/enter?as=lead"');
    const enter = await page("/demo/enter?as=lead", "");
    expect(enter.status).toBe(302);
    const set = enter.headers.getSetCookie().join("; ");
    expect(set).toMatch(
      /__Secure-demo=lead; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax/,
    );
    expect(set).not.toMatch(/Domain=/i);
    await enter.text();
    cookie = "__Secure-demo=lead";

    const home = await (await page("/")).text();
    expect(home).toContain("This is a demo camp with made-up people");
    expect(home).toContain("Welcome, Compass");
    expect(home).not.toContain("Sign out");
    const people = await (await page("/people")).text();
    expect(people).toContain("Juniper Hale");
    expect(people).toContain("Lucia Ferro");
  });

  it("opens every page a Lead can, without an error (nothing tries to save on the way)", async () => {
    for (const path of [
      "/",
      "/rsvp",
      "/tickets/request",
      "/profile",
      "/yearbook",
      "/yearbook?view=directory",
      "/volunteer",
      "/guides",
      "/guides/welcome",
      "/people",
      "/people/new",
      "/people/import",
      `/people/${DEMO_LEAD_ID}`,
      "/roster",
      "/tickets",
      "/saps",
      "/volunteers",
      "/inquiries",
      "/queue",
      "/announcements",
      "/dates",
      "/guide-editor",
    ]) {
      const res = await page(path);
      expect(res.status, path).toBe(200);
      await res.text();
    }
    // Not a Treasurer or an Admin.
    for (const path of ["/dues", "/admin"]) {
      const res = await page(path);
      expect(res.status, path).toBe(403);
      await res.text();
    }
  });

  it("opens every Admin page as its Admin, without an error (issue #84)", async () => {
    const enter = await page("/demo/enter?as=admin", "");
    await enter.text();
    const admin = "__Secure-demo=admin";
    for (const path of [
      "/dues",
      "/admin",
      "/admin/guide",
      "/admin/emails",
      "/admin/emails/invite",
      "/admin/wording",
      "/admin/activity",
      "/admin/logs",
      "/admin/settings",
      "/admin/features",
      "/admin/support",
      "/admin/exports",
      "/admin/saps",
      "/admin/roles",
      "/admin/roles/new",
      "/admin/roles/lead",
    ]) {
      const res = await page(path, admin);
      // A switched-off feature's page is a 404; nothing may fail.
      expect([200, 404], path).toContain(res.status);
      await res.text();
    }
    expect((await page("/admin/support", admin)).status).toBe(200);
    // Issue #93: a custom role to look at, read-only, and no review prompt.
    const roles = await (await page("/admin/roles", admin)).text();
    expect(roles).toContain("Tickets coordinator");
    expect(roles).toContain("Can manage tickets");
    expect(roles).not.toContain("These look right");
  });

  it("refuses every change, with a page that says why, and changes nothing", async () => {
    const before = await counts();
    // A plain form post gets the Worker's page; a page's own post gets the app's, which the
    // browser renders from this reason.
    const plain = await w.fetch(post("/rsvp", { intent: "not_going" }, { cookie, base: DEMO }));
    expect(plain.status).toBe(403);
    expect(await plain.text()).toContain("Saving is off in the demo");
    const inPage = await w.fetch(
      post("/rsvp.data", { intent: "not_going" }, { cookie, base: DEMO }),
    );
    expect(inPage.status).toBe(403);
    expect(await inPage.text()).toContain("demo_read_only");
    const [mine] = await t.db
      .select()
      .from(participation)
      .where(eq(participation.personId, DEMO_LEAD_ID));
    expect(mine.intent).toBe("going");
    expect(await counts()).toBe(before);
  });

  it("never sends email, has no sign-in, and stores no files", async () => {
    const sent = w.emails.length;
    const signIn = await page("/sign-in", "");
    expect(signIn.headers.get("location")).toBe("/demo/enter");
    await signIn.text();
    const asked = await w.fetch(
      post("/sign-in", { email: "juniper.hale@example.com" }, { base: DEMO }),
    );
    expect(asked.status).toBe(403);
    await asked.text();
    const nudge = await w.fetch(
      post(`/people/${DEMO_LEAD_ID}`, { intent: "nudge" }, { cookie, base: DEMO }),
    );
    expect(nudge.status).toBe(403);
    await nudge.text();

    const form = new FormData();
    form.set("intent", "photo");
    form.set("photo", new File([new Uint8Array([1, 2, 3])], "me.jpg", { type: "image/jpeg" }));
    const up = await w.fetch(
      new Request(`${DEMO}/profile`, {
        method: "POST",
        headers: { origin: DEMO, cookie },
        body: form,
      }),
    );
    expect(up.status).toBe(403);
    await up.text();
    expect(w.emails.length).toBe(sent);
  });

  it("is read-only in the database too, if a write ever got past the checks", async () => {
    const clients = createClients(t.runtimeUrl);
    try {
      const db = campDb(clients, demoId, { readOnly: true });
      await expect(
        db.update(person).set({ legalName: "Changed" }).where(eq(person.id, DEMO_LEAD_ID)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/read-only transaction/) },
      });
    } finally {
      await endClients(clients);
    }
  });

  it("stores its JSON settings as JSON, not as strings", async () => {
    const [r] = await t.client`
      select jsonb_typeof(s.inquiry_notify) as notify,
        (select jsonb_typeof(sap_days) from burn b where b.camp_id = ${demoId} and sap_days is not null limit 1) as sap_days,
        (select count(*)::int from audit_log a where a.camp_id = ${demoId} and jsonb_typeof(a.after) = 'string') as string_audits
      from camp_settings s where s.camp_id = ${demoId}`;
    expect(r).toEqual({ notify: "array", sap_days: "array", string_audits: 0 });
    // And the Admin's settings page, which reads them, works.
    const res = await page("/admin/settings", "__Secure-demo=admin");
    expect(res.status).toBe(200);
    await res.text();
  });

  it("means nothing at a real camp", async () => {
    for (const path of ["/", "/people", "/roster", "/admin"]) {
      const res = await page(path, cookie, APP_URL);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/sign-in");
      await res.text();
    }
    const enter = await page("/demo/enter", "", APP_URL);
    expect(enter.status).toBe(404);
    await enter.text();
  });

  it("can be reset, keeping its id, and refuses to reset a real camp", async () => {
    const again = await resetDemoCamp(plain, { now: new Date("2026-10-01T12:00:00Z") });
    expect(again).toBe(demoId);
    expect(await counts()).toBeGreaterThan(20);
    expect(await t.client`select 1 from camp where slug = 'demo'`).toHaveLength(1);
    await expect(resetDemoCamp(plain, { slug: "testcamp" })).rejects.toThrow(/real camp/);
  });
});

describe("the richer demo (Lead workspace plan, Unit 9)", () => {
  it("shows SAP decisions both ways: approved with passes, and to decide with none left", async () => {
    const html = await (await page("/saps")).text();
    expect(html).toContain("Approved for");
    expect(html).toContain("pass DEMO-0001");
    expect(html).toContain("Waiting for a decision");
    expect(html).toContain("no passes left that day");
  });

  it("has some History on people's pages", async () => {
    const [theo] = await t.db.select().from(person).where(eq(person.legalName, "Theo Marsh"));
    const html = await (await page(`/people/${theo.id}`)).text();
    expect(html).toContain("RSVP: Going");
  });

  it("has an illustrated avatar for most people and a sample pass, at keys under its own prefix", async () => {
    const files = await demoFiles(demoId);
    const photos = files.filter((f) => f.key.includes("/p/"));
    expect(photos.length).toBeGreaterThan(20);
    for (const f of photos) {
      expect(inCamp(demoId, "p", f.key), f.key).toBe(true);
      expect(Buffer.from(f.bytes.slice(8, 12)).toString()).toBe("WEBP");
    }
    const pass = files.find((f) => f.key.includes("/sap/"));
    expect(pass && inCamp(demoId, "sap", pass.key)).toBe(true);
    expect(Buffer.from((pass as { bytes: Uint8Array }).bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(new Set(files.map((f) => f.key)).size).toBe(files.length);
    // Issue #64: its own logo.
    const logo = files.find((f) => f.key.includes("/logo/"));
    expect(logo && inCamp(demoId, "logo", logo.key)).toBe(true);
    expect(Buffer.from((logo as { bytes: Uint8Array }).bytes.slice(8, 12)).toString()).toBe("WEBP");
  });

  it("points people at their photos only when the files are uploaded too", async () => {
    const withPhotos = async () =>
      (
        await t.client`select count(*)::int as n from person where camp_id = ${demoId} and photo_key is not null`
      )[0].n;
    expect(await withPhotos()).toBe(0);
    await resetDemoCamp(plain, { now: new Date("2026-10-01T12:00:00Z"), withFiles: true });
    expect(await withPhotos()).toBeGreaterThan(20);
    const [pass] = await t.client`
      select pdf_key from sap_pass where camp_id = ${demoId} and serial = 'DEMO-0001'`;
    expect(pass.pdf_key).toMatch(new RegExp(`^camps/${demoId}/sap/`));
    // Yearbook cards for them.
    expect(await (await page("/yearbook?view=photos")).text()).toContain("/photos/");
  });

  it("has its own look, not the platform's default gold balloon (issue #64)", async () => {
    const html = await (await page("/")).text();
    // Its accent, with the lighter shades mixed from it.
    expect(html).toContain("--color-gold:#2ec4b6");
    expect(html).toContain("--color-gold-light:color-mix(in srgb, #2ec4b6 65%, white)");
    expect(html).toContain("--color-gold-glow:color-mix(in srgb, #2ec4b6 22%, white)");
    // And, with its files, its logo instead of the balloon.
    expect(html).toMatch(/<img src="\/logo\/[0-9a-f-]+\.webp"/);
  });
});
