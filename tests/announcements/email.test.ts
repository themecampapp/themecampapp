// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { announcement, auditLog, burn, memberRole, participation, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Emailing an announcement to the season's members (R62, U19): a preview of exactly what goes
// out, links stripped, sent once.

let t: TestDb;
let w: TestWorker;
let lead: string;
let member: string;

const showUntil = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
const emailsSince = (n: number) =>
  w.emails
    .slice(n)
    .map((e) => e.to)
    .sort();

beforeAll(async () => {
  t = await createTestDb();
  await seedZulu(t);
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  await invitePerson(t, "mo@example.com", { legalName: "Mo Member" });
  member = await signIn(w, "mo@example.com");
  const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  const ana = await invitePerson(t, "ana@example.com", { legalName: "Ana" });
  const ben = await invitePerson(t, "ben@example.com", { legalName: "Ben" });
  const cy = await invitePerson(t, "cy@example.com", { legalName: "Cy" });
  await invitePerson(t, "dee@example.com", { legalName: "Dee", active: false });
  // Never invited and never signed in: not on the list.
  await t.db.insert(person).values({ legalName: "Fin", email: "fin@example.com" });
  await t.db.insert(participation).values([
    { personId: ana.id, burnId: season.id, intent: "going" },
    { personId: ben.id, burnId: season.id, intent: "leaning_no" },
    { personId: cy.id, burnId: season.id, intent: "not_going" },
  ]);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const RECIPIENTS = [
  "ana@example.com",
  "ben@example.com",
  "lead@example.com",
  "mo@example.com",
].sort();

describe("emailing an announcement", () => {
  let id: string;

  it("posts first, then previews exactly what goes out, sending nothing yet", async () => {
    const before = w.emails.length;
    const res = await w.fetch(
      post(
        "/announcements",
        {
          intent: "post",
          title: "Build weekend",
          body: "Sign up at https://evil.example/form or email x@evil.example.\nBring gloves.",
          showUntil,
          email: "on",
        },
        { cookie: lead },
      ),
    );
    expect(res.status).toBe(302);
    const to = res.headers.get("location") ?? "";
    expect(to).toMatch(/^\/announcements\?email=[0-9a-f-]{36}$/);
    await res.text();
    id = to.split("=")[1];
    const html = await (await w.fetch(get(to, lead))).text();
    expect(html).toContain("Test Camp: Build weekend");
    expect(html).toContain("Sign up at [link removed] or email [link removed].");
    expect(html).toContain("Bring gloves.");
    expect(html).toContain("2 links were taken out");
    expect(html).toContain(`Send to ${RECIPIENTS.length}`);
    // The page's own list shows the announcement with its links; the email preview doesn't.
    const box = html.slice(
      html.indexOf("Email “Build weekend”"),
      html.indexOf("On the home page now"),
    );
    expect(box).toContain("Read it on the camp site: https://testcamp.themecamp.test");
    expect(box).not.toContain("evil.example");
    expect(w.emails.length).toBe(before);
  });

  it("sends to this season's active members except those not going, once, and audits it", async () => {
    const before = w.emails.length;
    const res = await w.fetch(
      post("/announcements", { intent: "send_email", id }, { cookie: lead }),
    );
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      `Emailed to ${RECIPIENTS.length} people.`,
    );
    await res.text();
    expect(emailsSince(before)).toEqual(RECIPIENTS);
    const sent = w.emails.slice(before)[0];
    expect(sent.subject).toBe("Test Camp: Build weekend");
    expect(sent.text).toContain("[link removed]");
    expect(sent.text).not.toMatch(/evil\.example/);
    expect(sent.text).toContain("Read it on the camp site:");
    const [a] = await t.db.select().from(announcement).where(eq(announcement.id, id));
    expect(a.emailedAt).not.toBeNull();
    expect(a.emailedCount).toBe(RECIPIENTS.length);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "announcement_emailed"), eq(auditLog.campId, t.campId)));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ recipients: 4, sent: 4, linksRemoved: 2 });
  });

  it("never sends it a second time", async () => {
    const before = w.emails.length;
    const res = await w.fetch(
      post("/announcements", { intent: "send_email", id }, { cookie: lead }),
    );
    expect(res.status).toBe(409);
    await res.text();
    const again = await w.fetch(get(`/announcements?email=${id}`, lead));
    expect(again.status).toBe(302);
    expect(decodeURIComponent(again.headers.get("location") ?? "")).toContain(
      "already been emailed",
    );
    await again.text();
    const html = await (await w.fetch(get("/announcements", lead))).text();
    expect(html).toMatch(/Emailed [A-Z][a-z]{2} \d+ to 4\./);
    // Editing it doesn't resend.
    await (
      await w.fetch(
        post(
          "/announcements",
          { intent: "edit", id, title: "Build weekend (updated)", body: "", showUntil },
          { cookie: lead },
        ),
      )
    ).text();
    expect(w.emails.length).toBe(before);
  });

  it("doesn't email when the box isn't ticked, and isn't open to members", async () => {
    const before = w.emails.length;
    const res = await w.fetch(
      post(
        "/announcements",
        { intent: "post", title: "Quiet one", body: "", showUntil },
        { cookie: lead },
      ),
    );
    expect(res.headers.get("location")).toContain("notice=");
    await res.text();
    const [quiet] = await t.db
      .select()
      .from(announcement)
      .where(eq(announcement.title, "Quiet one"));
    const denied = await w.fetch(
      post("/announcements", { intent: "send_email", id: quiet.id }, { cookie: member }),
    );
    expect([403, 404]).toContain(denied.status);
    await denied.text();
    expect(w.emails.length).toBe(before);
    const [still] = await t.db.select().from(announcement).where(eq(announcement.id, quiet.id));
    expect(still.emailedAt).toBeNull();
  });

  it("stops at the camp's daily limit and says how many went", async () => {
    await t.client`truncate send_log`;
    await t.client`update camp set daily_send_cap = 2 where id = ${t.campId}`;
    try {
      const posted = await w.fetch(
        post(
          "/announcements",
          { intent: "post", title: "Capped", body: "", showUntil, email: "on" },
          { cookie: lead },
        ),
      );
      const capped = (posted.headers.get("location") ?? "").split("=")[1];
      await posted.text();
      const before = w.emails.length;
      const res = await w.fetch(
        post("/announcements", { intent: "send_email", id: capped }, { cookie: lead }),
      );
      const notice = decodeURIComponent(res.headers.get("location") ?? "");
      await res.text();
      expect(w.emails.length - before).toBe(2);
      expect(notice).toContain("Emailed to 2 people.");
      expect(notice).toContain("2 held back: this camp reached today's email limit.");
      expect(notice).not.toContain("failed to send");
      const [a] = await t.db.select().from(announcement).where(eq(announcement.id, capped));
      expect(a.emailedCount).toBe(2);
    } finally {
      await t.client`update camp set daily_send_cap = 300 where id = ${t.campId}`;
    }
  });
});
