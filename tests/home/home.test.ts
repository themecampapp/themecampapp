// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  announcement,
  auditLog,
  burn,
  campSettings,
  keyDate,
  memberRole,
  participation,
  ticketRequest,
} from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { recordDues } from "~/lib/data/dues.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// The home page (R72), announcements (R61), key dates (R63) and the ticket-lock reminder (R64).

let t: TestDb;
let w: TestWorker;
let member: { id: string; cookie: string };
let lead: { id: string; cookie: string };
let lead2: { id: string; cookie: string };
let admin: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const home = async (cookie: string) => (await w.fetch(get("/", cookie))).text();

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const m = await invitePerson(t, "member@example.com", { legalName: "Mo Member" });
  member = { id: m.id, cookie: await signIn(w, "member@example.com") };
  for (const [email, key] of [
    ["lead@example.com", "lead"],
    ["lead2@example.com", "lead2"],
  ] as const) {
    const p = await invitePerson(t, email);
    await t.db.insert(memberRole).values({ personId: p.id, role: "lead" });
    const person = { id: p.id, cookie: await signIn(w, email) };
    if (key === "lead") lead = person;
    else lead2 = person;
  }
  const a = await invitePerson(t, "admin@example.com");
  await t.db.insert(memberRole).values({ personId: a.id, role: "admin" });
  admin = await signIn(w, "admin@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate announcement, key_date, participation, ticket_request, dues, audit_log cascade`;
  await t.db.update(burn).set({ ticketRequestsLocked: false, duesAmountCents: null });
  await t.db.update(campSettings).set({ featureDues: true });
});

describe("announcements", () => {
  const postIt = (title: string, showUntil = day(1), cookie = lead.cookie) =>
    w.fetch(post("/announcements", { intent: "post", title, body: "", showUntil }, { cookie }));

  it("a Lead posts one and members see it, newest first", async () => {
    expect((await postIt("Build weekend")).status).toBe(302);
    expect((await postIt("Potluck Friday")).status).toBe(302);
    const html = await home(member.cookie);
    expect(html.indexOf("Potluck Friday")).toBeGreaterThan(-1);
    expect(html.indexOf("Potluck Friday")).toBeLessThan(html.indexOf("Build weekend"));
  });

  it("won't post the same announcement twice while it's showing", async () => {
    expect((await postIt("Build weekend")).status).toBe(302);
    const again = await postIt("build weekend");
    expect(again.status).not.toBe(302);
    expect(await again.text()).toContain("That announcement is already on the home page.");
    // Two at once (a double click): only one lands.
    const both = await Promise.all([postIt("Potluck"), postIt("Potluck")]);
    expect(both.filter((r) => r.status === 302)).toHaveLength(1);
    await Promise.all(both.map((r) => r.text()));
    const rows = await t.db.select().from(announcement);
    expect(rows.map((r) => r.title).sort()).toEqual(["Build weekend", "Potluck"]);
    // Once the first has come down, the same one can go up again.
    await t.db.update(announcement).set({ showUntil: day(-1) });
    expect((await postIt("Build weekend")).status).toBe(302);
  });

  it("shows https links with their full address, and nothing else as a link", async () => {
    await w.fetch(
      post(
        "/announcements",
        {
          intent: "post",
          title: "Links",
          body: "See https://burningman.org/event. Not http://example.com or <b>bold</b>",
          showUntil: day(1),
        },
        { cookie: lead.cookie },
      ),
    );
    const html = await home(member.cookie);
    expect(html).toContain(
      '<a href="https://burningman.org/event" rel="nofollow noopener ugc" class="break-all underline">https://burningman.org/event</a>',
    );
    expect(html).not.toContain('href="http://example.com"');
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("comes down after its last day, and can't be set past the maximum or in the past", async () => {
    await postIt("Short lived");
    await t.db.update(announcement).set({ showUntil: day(-1) });
    expect(await home(member.cookie)).not.toContain("Short lived");

    const tooFar = await postIt("Too far", day(31));
    expect(await tooFar.text()).toContain("30 days at most");
    const past = await postIt("Too late", day(-1));
    expect(await past.text()).toContain("can&#x27;t be in the past");
    expect(
      await t.db.select().from(announcement).where(eq(announcement.title, "Too far")),
    ).toHaveLength(0);
  });

  it("another Lead can edit and then remove it, and both are audited", async () => {
    await postIt("Original");
    const [a] = await t.db.select().from(announcement);
    await w.fetch(
      post(
        "/announcements",
        { intent: "edit", id: a.id, title: "Edited", body: "", showUntil: day(2) },
        { cookie: lead2.cookie },
      ),
    );
    expect(await home(member.cookie)).toContain("Edited");
    await w.fetch(post("/announcements", { intent: "remove", id: a.id }, { cookie: lead2.cookie }));
    expect(await home(member.cookie)).not.toContain("Edited");

    const rows = await t.db
      .select({ action: auditLog.action, actor: auditLog.actorPersonId })
      .from(auditLog)
      .where(eq(auditLog.subjectId, a.id));
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "announcement_posted", actor: lead.id },
        { action: "announcement_edited", actor: lead2.id },
        { action: "announcement_removed", actor: lead2.id },
      ]),
    );
  });

  it("is for Leads only", async () => {
    expect((await w.fetch(get("/announcements", member.cookie))).status).toBe(403);
    const res = await postIt("Nope", day(1), member.cookie);
    expect(res.status).toBe(403);
    await res.text();
  });
});

describe("your to-dos", () => {
  it("asks for an RSVP, tickets and dues, then says you're all set", async () => {
    const [season] = await t.db.select().from(burn).where(sql`${burn.year} = 2027`);
    await t.db.update(burn).set({ duesAmountCents: 15000 }).where(eq(burn.id, season.id));
    let html = await home(member.cookie);
    expect(html).toContain("RSVP for this year");
    expect(html).not.toContain("You&#x27;re all set");

    const [pa] = await t.db
      .insert(participation)
      .values({ personId: member.id, burnId: season.id, intent: "going" })
      .returning();
    html = await home(member.cookie);
    expect(html).not.toContain("RSVP for this year");
    expect(html).toContain("Request Stewards Sale tickets");
    expect(html).toContain("Pay your dues ($150)");

    await t.db
      .insert(ticketRequest)
      .values({ participationId: pa.id, ticketsNeeded: 0, hasTicketElsewhere: true });
    const treasurer = { personId: lead.id, ...asRoles(["lead", "treasurer"]) } as Viewer;
    await recordDues(t.db, treasurer, member.id, {
      status: "paid",
      amount: "150",
      paidOn: day(0),
      method: "venmo",
    });
    html = await home(member.cookie);
    expect(html).toContain("You&#x27;re all set");
  });

  it("leaves dues out when the camp has dues switched off", async () => {
    const [season] = await t.db.select().from(burn).where(sql`${burn.year} = 2027`);
    await t.db.update(burn).set({ duesAmountCents: 15000 }).where(eq(burn.id, season.id));
    await t.db
      .insert(participation)
      .values({ personId: member.id, burnId: season.id, intent: "going" });
    await t.db.update(campSettings).set({ featureDues: false });
    expect(await home(member.cookie)).not.toContain("Pay your dues");
  });
});

describe("key dates", () => {
  const add = (label: string, date: string, action = "") =>
    w.fetch(post("/dates", { intent: "add", label, date, action }, { cookie: lead.cookie }));

  it("shows upcoming dates in order, and not past ones", async () => {
    await add("Early build", day(10));
    await add("Burn night", day(20));
    await add("Last year's thing", day(-3));
    const html = await home(member.cookie);
    expect(html.indexOf("Early build")).toBeLessThan(html.indexOf("Burn night"));
    expect(html).not.toContain("Last year&#x27;s thing");
    const rows = await t.db.select({ action: auditLog.action }).from(auditLog);
    expect(rows.filter((r) => r.action === "key_date_added")).toHaveLength(3);
  });

  it("hides a date tied to dues when dues are off", async () => {
    await add("Dues deadline", day(5), "dues_due");
    expect(await home(member.cookie)).toContain("Dues deadline");
    await t.db.update(campSettings).set({ featureDues: false });
    expect(await home(member.cookie)).not.toContain("Dues deadline");
    expect(await (await w.fetch(get("/dates", lead.cookie))).text()).toContain(
      "hidden: dues are switched off",
    );
  });

  it("keeps a date's tie to dues when it's edited while dues are off", async () => {
    await add("Dues deadline", day(5), "dues_due");
    await t.db.update(campSettings).set({ featureDues: false });
    const html = await (await w.fetch(get("/dates", lead.cookie))).text();
    expect(html).toMatch(/<option value="dues_due"[^>]*>Dues are due \(switched off\)<\/option>/);
    const [d] = await t.db.select().from(keyDate);
    await w.fetch(
      post(
        "/dates",
        {
          intent: "edit",
          id: d.id,
          label: "Dues deadline (fixed)",
          date: day(5),
          action: "dues_due",
        },
        { cookie: lead.cookie },
      ),
    );
    const [after] = await t.db.select().from(keyDate);
    expect(after).toMatchObject({ label: "Dues deadline (fixed)", action: "dues_due" });
  });

  it("refuses dates that aren't on the calendar, with a message", async () => {
    for (const date of ["2027-04-31", "2027-02-30"]) {
      const res = await add("Bad", date);
      expect(await res.text()).toContain("Choose a date.");
    }
    const res = await w.fetch(
      post(
        "/announcements",
        { intent: "post", title: "Bad", body: "", showUntil: "2027-06-31" },
        { cookie: lead.cookie },
      ),
    );
    expect(await res.text()).toContain("Choose the last day it should show.");
    expect(await t.db.select().from(keyDate)).toHaveLength(0);
  });

  it("reminds Leads, not members, to lock ticket requests once their close date passes", async () => {
    await add("Requests close", day(-1), "tickets_close");
    expect(await home(lead.cookie)).toContain("Lock them on the Stewards Sale page");
    expect(await home(member.cookie)).not.toContain("Lock them on the Stewards Sale page");
    await t.db.update(burn).set({ ticketRequestsLocked: true });
    expect(await home(lead.cookie)).not.toContain("Lock them on the Stewards Sale page");
  });

  it("doesn't remind before the date", async () => {
    await add("Requests close", day(3), "tickets_close");
    expect(await home(lead.cookie)).not.toContain("Lock them on the Stewards Sale page");
  });
});

describe("the home page's order", () => {
  it("gives Leads an Overview (camp to-dos, setup, announcements, dates) and their own view; members get theirs", async () => {
    await w.fetch(
      post(
        "/announcements",
        { intent: "post", title: "Hello camp", body: "", showUntil: day(1) },
        { cookie: lead.cookie },
      ),
    );
    await w.fetch(
      post(
        "/dates",
        { intent: "add", label: "Soon", date: day(4), action: "" },
        { cookie: lead.cookie },
      ),
    );
    // The setup block is the checklist, which only a camp created in the console has (U16).
    await t.client`update camp set created_in_console = true`;
    await t.client`update camp_settings set agreement_accepted_at = now()`;
    try {
      const inOrder = (html: string, parts: string[]) => {
        const at = parts.map((p) => html.indexOf(p));
        expect(
          at.every((i) => i > -1),
          parts.join(" / "),
        ).toBe(true);
        expect(at).toEqual([...at].sort((a, b) => a - b));
      };
      for (const cookie of [lead.cookie, admin]) {
        // The Overview is where Leads land.
        const overview = await home(cookie);
        expect(overview).toMatch(/aria-current="page"[^>]*>Overview/);
        inOrder(overview, ["Camp to-dos", "Setting up your camp", "Hello camp", "Coming up"]);
        expect(overview).not.toContain("Your to-dos");
        // Their own participation is one tap away.
        const mine = await (await w.fetch(get("/?view=mine", cookie))).text();
        inOrder(mine, ["Your to-dos", "Hello camp", "Coming up"]);
        expect(mine).not.toContain("Setting up your camp");
        expect(mine).not.toContain("Camp to-dos");
      }
      const forMember = await home(member.cookie);
      expect(forMember).not.toContain("My participation");
      expect(forMember).not.toContain("Camp to-dos");
      expect(forMember).not.toContain("Setting up your camp");
      inOrder(forMember, ["Your to-dos", "Hello camp"]);
    } finally {
      await t.client`update camp set created_in_console = false`;
      await t.client`update camp_settings set agreement_accepted_at = null`;
    }
  });

  it("always gives Admins the Theme Camp App Discord on the Overview, and nobody else (issue #82)", async () => {
    const forAdmin = await home(admin);
    expect(forAdmin).toContain("Theme Camp App admin community");
    expect(forAdmin).toContain("the way to talk with the app&#x27;s developer");
    expect(forAdmin).toContain("best way to get support or ask for new features");
    expect(forAdmin).toMatch(/<a href="https:\/\/discord\.gg\/support-test" target="_blank"/);
    // Not part of the checklist: there whether or not the camp has one.
    expect(forAdmin).not.toContain("Setting up your camp");
    expect(await (await w.fetch(get("/?view=mine", admin))).text()).not.toContain(
      "admin community",
    );
    for (const cookie of [lead.cookie, member.cookie]) {
      expect(await home(cookie)).not.toContain("admin community");
    }
  });

  it("leaves out empty announcement and date blocks for members", async () => {
    const html = await home(member.cookie);
    expect(html).not.toContain(">Announcements<");
    expect(html).not.toContain("Coming up");
    expect(html).toContain("Your to-dos");
  });
});
