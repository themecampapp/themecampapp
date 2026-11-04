// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLog,
  burn,
  camp,
  emailSuppression,
  memberRole,
  participation,
  person,
  sendLog,
} from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let leadCookie: string;
let memberCookie: string;
const ids: Record<string, string> = {};

const sentTo = (from: number) =>
  w.emails
    .slice(from)
    .map((e) => e.to)
    .sort();

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));

  const lead = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
  leadCookie = await signIn(w, "lead@example.com");
  await w.fetch(get("/", leadCookie));
  await t.db
    .insert(participation)
    .values({ personId: lead.id, burnId: season.id, intent: "going" });

  // Invited, never signed in, no RSVP: nudged.
  ids.invited = (await invitePerson(t, "invited@example.com", { legalName: "Ivy Invited" })).id;
  // Signed in, no RSVP: nudged.
  ids.signedIn = (await invitePerson(t, "signedin@example.com", { legalName: "Sid Signedin" })).id;
  memberCookie = await signIn(w, "signedin@example.com");
  await w.fetch(get("/", memberCookie));
  // Has RSVP'd: not nudged.
  ids.rsvpd = (await invitePerson(t, "rsvpd@example.com", { legalName: "Rae Rsvpd" })).id;
  await t.db
    .insert(participation)
    .values({ personId: ids.rsvpd, burnId: season.id, intent: "leaning_no" });
  // Never invited: not nudged (they'd have no way in yet).
  const [uninvited] = await t.db
    .insert(person)
    .values({ legalName: "Una Uninvited", email: "uninvited@example.com" })
    .returning();
  ids.uninvited = uninvited.id;
  // Deactivated: not nudged.
  ids.gone = (
    await invitePerson(t, "gone@example.com", { legalName: "Gil Gone", active: false })
  ).id;
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("RSVP nudge emails", () => {
  it("offers the button on the No RSVP view with the number who'll get it", async () => {
    const html = await (await w.fetch(get("/roster?preset=no-rsvp", leadCookie))).text();
    expect(html).toContain("Send RSVP nudge email (2)");
    expect(await (await w.fetch(get("/roster", leadCookie))).text()).not.toContain(
      "Send RSVP nudge email",
    );
  });

  it("emails everyone invited who hasn't RSVP'd, with a sign-in link, and audits it", async () => {
    const before = w.emails.length;
    const res = await w.fetch(post("/roster", { intent: "nudge_all" }, { cookie: leadCookie }));
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain("Sent 2 RSVP nudges.");
    expect(sentTo(before)).toEqual(["invited@example.com", "signedin@example.com"]);
    const mail = w.emails.slice(before).find((e) => e.to === "invited@example.com");
    expect(mail?.text).toContain("2027");
    expect(mail?.text).toContain("/sign-in?email=invited%40example.com");
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, "rsvp_nudge_sent"));
    expect(a.after).toMatchObject({ count: 2, failed: 0 });

    const html = await (await w.fetch(get("/roster?preset=no-rsvp", leadCookie))).text();
    // Each row shows when they were last nudged.
    expect(html).toContain(">Last nudged<");
    expect(html).toMatch(/>\d{1,2}\/\d{1,2}\/\d{4}</);
    expect(html).toContain("Send RSVP nudge email (0)");
  });

  it("doesn't nudge the same people again within the cooldown", async () => {
    const before = w.emails.length;
    const res = await w.fetch(post("/roster", { intent: "nudge_all" }, { cookie: leadCookie }));
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain(
      "Sent 0 RSVP nudges. 2 skipped",
    );
    expect(w.emails.length).toBe(before);
  });

  it("nudges one person from their page once the cooldown has passed", async () => {
    const page = await (await w.fetch(get(`/people/${ids.invited}`, leadCookie))).text();
    expect(page).toContain("Send RSVP nudge email");
    expect(page).toContain("Last nudged");

    await t.db.execute(
      sql`update send_log set created_at = now() - interval '4 days' where kind = 'rsvp_nudge'`,
    );
    const before = w.emails.length;
    const res = await w.fetch(
      post(`/people/${ids.invited}`, { intent: "nudge" }, { cookie: leadCookie }),
    );
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain("RSVP nudge sent.");
    expect(sentTo(before)).toEqual(["invited@example.com"]);
  });

  it("never nudges someone who RSVP'd, wasn't invited, or is deactivated", async () => {
    for (const id of [ids.rsvpd, ids.uninvited]) {
      const page = await (await w.fetch(get(`/people/${id}`, leadCookie))).text();
      expect(page).not.toContain("Send RSVP nudge email");
    }
    const before = w.emails.length;
    for (const id of [ids.rsvpd, ids.uninvited, ids.gone]) {
      await w.fetch(post(`/people/${id}`, { intent: "nudge" }, { cookie: leadCookie }));
    }
    expect(w.emails.length).toBe(before);
  });

  it("refuses Members", async () => {
    const before = w.emails.length;
    const res = await w.fetch(post("/roster", { intent: "nudge_all" }, { cookie: memberCookie }));
    expect(res.status).toBe(403);
    expect(w.emails.length).toBe(before);
  });
});

describe("nudges the camp can't send", () => {
  it("tells the Lead the camp's email is paused, and sends nothing", async () => {
    const id = (await invitePerson(t, "paused@example.com", { legalName: "Pat Paused" })).id;
    await t.db.update(camp).set({ sendingPaused: true }).where(eq(camp.id, t.campId));
    try {
      const before = w.emails.length;
      const res = await w.fetch(post(`/people/${id}`, { intent: "nudge" }, { cookie: leadCookie }));
      expect(res.status).toBe(302);
      const notice = new URL(res.headers.get("Location") ?? "", "https://x").searchParams.get(
        "notice",
      );
      expect(notice).toMatch(/1 held back: this camp's email is paused/);
      expect(w.emails.length).toBe(before);
      const [log] = await t.db
        .select()
        .from(sendLog)
        .where(eq(sendLog.recipient, "paused@example.com"));
      expect(log.status).toBe("paused");
    } finally {
      await t.db.update(camp).set({ sendingPaused: false }).where(eq(camp.id, t.campId));
    }
  });

  it("reports a suppressed address as a plain failure", async () => {
    const id = (await invitePerson(t, "bounced@example.com", { legalName: "Bo Bounced" })).id;
    await t.db.insert(emailSuppression).values({ email: "bounced@example.com", reason: "bounce" });
    const res = await w.fetch(post(`/people/${id}`, { intent: "nudge" }, { cookie: leadCookie }));
    const notice = new URL(res.headers.get("Location") ?? "", "https://x").searchParams.get(
      "notice",
    );
    expect(notice).toBe("The nudge email didn't send; see the Queue.");
  });
});
