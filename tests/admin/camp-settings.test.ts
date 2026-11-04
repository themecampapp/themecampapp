// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, camp, memberRole, participation, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { getCampSettings, saveCampSettings } from "~/lib/data/camp-settings.server";
import { recordDues } from "~/lib/data/dues.server";
import { currentYear, saveRsvp } from "~/lib/data/participation.server";
import { rollOver, switchSeason } from "~/lib/data/season.server";
import { saveTicketRequest } from "~/lib/data/tickets.server";
import { FEATURES } from "~/lib/features";
import { campName } from "~/lib/mail.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { TEST_CAMP_ID } from "../helpers/seed";
import { asRoles } from "../helpers/viewer";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let admin: string;
let lead: string;
let member: string;
let adminViewer: Viewer;

const DEFAULTS = {
  name: "Test Camp",
  accent: "",
  contactEmail: "",
  joinIntro: "",
  inquiryNotify: "leads@example.com",
  maxTickets: "2",
  paymentMethods: "venmo\nzelle\ncash\nother",
};
const ALL_ON = FEATURES.map((f): [string, string] => ["on", f.key]);

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const a = await invitePerson(t, "admin@example.com", { legalName: "Ada Admin" });
  await t.db.insert(memberRole).values({ personId: a.id, role: "admin" });
  adminViewer = {
    personId: a.id,
    authUserId: "x",
    legalName: "Ada Admin",
    playaName: null,
    ...asRoles(["admin"]),
  };
  admin = await signIn(w, "admin@example.com");
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  const m = await invitePerson(t, "member@example.com", { legalName: "Mo Member" });
  await saveRsvp(t.db, m.id, m.id, {
    intent: "going",
    arrivalDate: null,
    departureDate: null,
    sapRequested: true,
    sapDate: null,
    dwellingDescription: null,
    dwellingSize: null,
    generator: null,
  });
  member = await signIn(w, "member@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await saveCampSettings(t.db, adminViewer, DEFAULTS);
  await w.fetch(post("/admin/features", ALL_ON, { cookie: admin }));
});

describe("camp settings", () => {
  it("uses the default palette, untouched, until a camp sets an accent", async () => {
    const html = await (await w.fetch(get("/", member))).text();
    expect(html).not.toContain("--color-gold:");
    expect(html).not.toContain("--color-gold-light:");
  });

  it("shows the camp's name and accent colour once an Admin saves them", async () => {
    const res = await w.fetch(
      post(
        "/admin/settings",
        { ...DEFAULTS, name: "  Dust  Bunnies ", accent: "#9FE8C8" },
        {
          cookie: admin,
        },
      ),
    );
    expect(res.status).toBe(302);
    const html = await (await w.fetch(get("/", member))).text();
    expect(html).toContain("<title>Home · Dust Bunnies</title>");
    expect(html).toContain("--color-gold:#9fe8c8");
    // The lighter shades follow it (issue #64), so nothing stays the default gold.
    expect(html).toContain("--color-gold-light:color-mix(in srgb, #9fe8c8 65%, white)");
    expect(html).toContain("--color-gold-glow:color-mix(in srgb, #9fe8c8 22%, white)");
    expect(await campName(t.db)).toBe("Dust Bunnies");
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "camp_settings_saved"))
      .orderBy(desc(auditLog.createdAt));
    expect(row).toMatchObject({
      actorPersonId: adminViewer.personId,
      after: expect.objectContaining({ displayName: "Dust Bunnies", accent: "#9fe8c8" }),
    });
  });

  it("refuses an accent too dark for the app's dark text, and saves nothing", async () => {
    const res = await w.fetch(
      post(
        "/admin/settings",
        { ...DEFAULTS, name: "Night Owls", accent: "#1d2b64" },
        {
          cookie: admin,
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/light enough|too dark/i);
    expect((await getCampSettings(t.db)).name).toBe("Test Camp");
  });

  it("checks the other fields", async () => {
    const refused = async (input: Partial<typeof DEFAULTS>) =>
      saveCampSettings(t.db, adminViewer, { ...DEFAULTS, ...input }).then(
        () => null,
        (e) => e.data.reason,
      );
    expect(await refused({ name: "  " })).toBe("camp_name_needed");
    expect(await refused({ accent: "yellow" })).toBe("accent_not_a_colour");
    for (const name of ["Verify at evil.tld", "https://x", "www.camp", "camp.app"]) {
      expect(await refused({ name }), name).toBe("camp_name_link");
    }
    expect(await refused({ name: "Camp St. Elmo" })).toBeNull();
    expect(await refused({ name: "x".repeat(61) })).toBe("camp_name_too_long");
    expect(await refused({ contactEmail: "not-an-email" })).toBe("invalid_email");
    expect(await refused({ inquiryNotify: "a@example.com\nnope" })).toBe("notify_email_invalid");
    expect(await refused({ maxTickets: "11" })).toBe("max_tickets_range");
    expect(await refused({ maxTickets: "0" })).toBe("max_tickets_range");
    expect(await refused({ paymentMethods: " \n " })).toBe("payment_methods_needed");
    await expect(
      saveCampSettings(t.db, { ...adminViewer, isAdmin: false }, DEFAULTS),
    ).rejects.toMatchObject({ data: { reason: "admin_only" } });
  });

  it("is for Admins only", async () => {
    expect((await w.fetch(get("/admin/settings", lead))).status).toBe(403);
    expect((await w.fetch(post("/admin/settings", DEFAULTS, { cookie: lead }))).status).toBe(403);
    expect((await w.fetch(get("/admin/features", lead))).status).toBe(403);
    expect((await w.fetch(post("/admin/features", [], { cookie: lead }))).status).toBe(403);
  });

  it("uses the camp's name in emails", async () => {
    await saveCampSettings(t.db, adminViewer, { ...DEFAULTS, name: "Dust Bunnies" });
    const html = await (await w.fetch(get("/admin/emails/invite", admin))).text();
    expect(html).toContain("the Dust Bunnies camp app");
  });
});

describe("features", () => {
  it("new camps start with dues, the join page and the Yearbook on, the rest off", async () => {
    const cols = await t.client<{ column_name: string; column_default: string }[]>`
      select column_name, column_default from information_schema.columns
      where table_name = 'camp_settings' and column_name like 'feature_%'`;
    const defaults = Object.fromEntries(cols.map((c) => [c.column_name, c.column_default]));
    for (const f of FEATURES) {
      expect(defaults[`feature_${f.key}`], f.key).toBe(String(f.defaultOn));
    }
    expect(FEATURES.filter((f) => f.defaultOn).map((f) => f.key)).toEqual([
      "dues",
      "join",
      "yearbook",
    ]);
  });

  it("switching SAPs off hides its pages, navigation and RSVP question, and keeps the data", async () => {
    const res = await w.fetch(
      post(
        "/admin/features",
        ALL_ON.filter(([, k]) => k !== "saps"),
        { cookie: admin },
      ),
    );
    expect(res.status).toBe(302);
    expect((await w.fetch(get("/saps", lead))).status).toBe(404);
    expect((await w.fetch(get("/admin/saps", admin))).status).toBe(404);
    const home = await (await w.fetch(get("/", admin))).text();
    expect(home).not.toContain('href="/saps"');
    const admins = await (await w.fetch(get("/admin", admin))).text();
    expect(admins).not.toContain('href="/admin/saps"');
    const emails = await (await w.fetch(get("/admin/emails", admin))).text();
    expect(emails).not.toContain("SAP approved");
    expect((await w.fetch(get("/admin/emails/sap_approved", admin))).status).toBe(404);

    const rsvp = await (await w.fetch(get("/rsvp", member))).text();
    expect(rsvp).not.toContain("Setup Access Pass");
    expect(rsvp).toMatch(/type="hidden" name="sapRequested" value="yes"/);
    const [pa] = await t.db.select().from(participation);
    expect(pa.sapRequested).toBe(true);

    await w.fetch(post("/admin/features", ALL_ON, { cookie: admin }));
    expect((await w.fetch(get("/saps", lead))).status).toBe(200);
  });

  it("switching the join page off makes it a 404", async () => {
    await w.fetch(
      post(
        "/admin/features",
        ALL_ON.filter(([, k]) => k !== "join"),
        { cookie: admin },
      ),
    );
    expect((await w.fetch(get("/join"))).status).toBe(404);
    expect((await w.fetch(get("/inquiries", lead))).status).toBe(404);
    const emails = await (await w.fetch(get("/admin/emails", admin))).text();
    expect(emails).not.toContain("Join form confirmation");
  });
});

describe("ticket limit and payment methods", () => {
  it("lets campers request up to the camp's limit", async () => {
    const [m] = await t.db.select().from(person).where(eq(person.email, "member@example.com"));
    const want = (n: number) => ({
      ticketsNeeded: n,
      hasTicketElsewhere: false,
      vehiclePassNeeded: false,
      note: null,
    });
    await expect(saveTicketRequest(t.db, m.id, m.id, want(3))).rejects.toMatchObject({
      data: { reason: "tickets_over_limit" },
    });
    await saveCampSettings(t.db, adminViewer, { ...DEFAULTS, maxTickets: "4" });
    await saveTicketRequest(t.db, m.id, m.id, want(4));
    await expect(saveTicketRequest(t.db, m.id, m.id, want(5))).rejects.toMatchObject({
      data: { reason: "tickets_over_limit" },
    });
    const page = await (await w.fetch(get("/tickets/request", member))).text();
    expect(page).toMatch(/<option value="4"[^>]*>4<\/option>/);
    expect(page).not.toContain('<option value="5">');
  });

  it("records dues only with one of the camp's payment methods", async () => {
    const [m] = await t.db.select().from(person).where(eq(person.email, "member@example.com"));
    const paid = { status: "paid", amount: "100", paidOn: "2027-03-01", method: "PayPal" };
    await expect(recordDues(t.db, adminViewer, m.id, paid)).rejects.toMatchObject({
      data: { reason: "dues_method_needed" },
    });
    await saveCampSettings(t.db, adminViewer, { ...DEFAULTS, paymentMethods: "Venmo\nPayPal" });
    expect((await getCampSettings(t.db)).paymentMethods).toEqual(["venmo", "PayPal"]);
    await recordDues(t.db, adminViewer, m.id, paid);
    await recordDues(t.db, adminViewer, m.id, { ...paid, method: "venmo" });
    await expect(
      recordDues(t.db, adminViewer, m.id, { ...paid, method: "zelle" }),
    ).rejects.toMatchObject({ data: { reason: "dues_method_needed" } });
  });
});

describe("rollover and suspension", () => {
  it("keeps the camp's settings and features through a rollover", async () => {
    await saveCampSettings(t.db, adminViewer, {
      ...DEFAULTS,
      name: "Dust Bunnies",
      maxTickets: "4",
    });
    const year = await currentYear(t.db);
    await rollOver(t.db, adminViewer, { fromYear: year, came: [] });
    try {
      const s = await getCampSettings(t.db);
      expect(s.currentYear).toBe(year + 1);
      expect(s).toMatchObject({ name: "Dust Bunnies", maxTickets: 4 });
      expect(Object.values(s.features).every(Boolean)).toBe(true);
    } finally {
      await switchSeason(t.db, adminViewer, year);
    }
  });

  it("tells members when the camp is suspended", async () => {
    await t.db.update(camp).set({ status: "suspended" }).where(eq(camp.id, TEST_CAMP_ID));
    try {
      const html = await (await w.fetch(get("/", member))).text();
      expect(html).toContain("This camp is suspended");
    } finally {
      await t.db.update(camp).set({ status: "active" }).where(eq(camp.id, TEST_CAMP_ID));
    }
    expect(await (await w.fetch(get("/", member))).text()).not.toContain("This camp is suspended");
  });
});
