// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, burn, invite, memberRole, participation, person, sendLog } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let leadCookie: string;
let memberCookie: string;
let memberId: string;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const lead = await invitePerson(t, "lead@example.com", { playaName: "Captain" });
  await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
  leadCookie = await signIn(w, "lead@example.com");
  const member = await invitePerson(t, "member@example.com", {
    legalName: "Plain Member",
    phone: "5550009999",
  });
  memberId = member.id;
  memberCookie = await signIn(w, "member@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("Lead-only pages through the real Worker", () => {
  it.each([
    "/people",
    "/people/new",
    "/people/invite",
    "/queue",
    "/roster",
    "/roster?preset=no-rsvp",
    "/tickets",
  ])("refuses a Member on GET %s", async (path) => {
    const res = await w.fetch(get(path, memberCookie));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).not.toContain("lead@example.com");
  });

  it("refuses a Member's POST to deactivate someone, and changes nothing", async () => {
    const res = await w.fetch(
      post(`/people/${memberId}`, { intent: "deactivate" }, { cookie: memberCookie }),
    );
    expect(res.status).toBe(403);
    const [p] = await t.db.select().from(person).where(eq(person.id, memberId));
    expect(p.active).toBe(true);
  });

  it("refuses a Member granting themselves Lead", async () => {
    const res = await w.fetch(
      post(`/people/${memberId}`, { intent: "grant", role: "lead" }, { cookie: memberCookie }),
    );
    expect(res.status).toBe(403);
    expect(
      await t.db.select().from(memberRole).where(eq(memberRole.personId, memberId)),
    ).toHaveLength(0);
  });

  it("refuses a Member changing someone's camp years", async () => {
    const res = await w.fetch(
      post(
        `/people/${memberId}`,
        { intent: "camp_years", year_2025: "yes" },
        { cookie: memberCookie },
      ),
    );
    expect(res.status).toBe(403);
    expect(
      await t.db.select().from(participation).where(eq(participation.personId, memberId)),
    ).toHaveLength(0);
  });

  it("lets a Lead record camp years, shown on the person page and People list", async () => {
    const res = await w.fetch(
      post(
        `/people/${memberId}`,
        {
          intent: "camp_years",
          year_2024: "yes",
          year_2025: "no",
          year_2026: "unknown",
          year_2027: "yes",
        },
        { cookie: leadCookie },
      ),
    );
    expect(res.status).toBe(302);
    const rows = await t.db
      .select({ year: burn.year, attended: participation.attended })
      .from(participation)
      .innerJoin(burn, eq(burn.id, participation.burnId))
      .where(eq(participation.personId, memberId));
    // 2027 isn't a past season and is ignored; "unknown" on an absent year writes nothing.
    expect(rows.sort((a, b) => a.year - b.year)).toEqual([
      { year: 2024, attended: true },
      { year: 2025, attended: false },
    ]);
    expect(
      await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "camp_year_set"), eq(auditLog.subjectId, memberId))),
    ).toHaveLength(2);

    const page = await (await w.fetch(get(`/people/${memberId}`, leadCookie))).text();
    expect(page).toContain("Camp year 2024 set to Came");
    expect(page).toMatch(
      /Camp year 2024 set to Came[\s\S]{0,200}by [\s\S]{0,20}<a[^>]*>Captain<\/a>/,
    );

    const list = await (await w.fetch(get("/people?status=all&year=2024", leadCookie))).text();
    expect(list).toContain("Plain Member");
    expect(list).toContain("Camped 2024");
    const other = await (await w.fetch(get("/people?status=all&year=2026", leadCookie))).text();
    expect(other).not.toContain("Plain Member");
  });

  it("filters Signed in to everyone who has signed in, including those who've RSVP'd", async () => {
    await w.fetch(get("/", leadCookie));
    await w.fetch(get("/", memberCookie));
    const [lead] = await t.db.select().from(person).where(eq(person.playaName, "Captain"));
    const [y] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await t.db
      .insert(participation)
      .values({ personId: lead.id, burnId: y.id, intent: "going", updatedByPersonId: lead.id })
      .onConflictDoUpdate({
        target: [participation.personId, participation.burnId],
        set: { intent: "going", updatedByPersonId: lead.id },
      });
    const html = await (await w.fetch(get("/people?status=signed_in", leadCookie))).text();
    expect(html).toContain("Captain");
    expect(html).toContain("Plain Member");
  });

  it("lists emails sent to a person in their History, including failures", async () => {
    await t.db.insert(sendLog).values([
      {
        kind: "rsvp_nudge",
        recipient: "member@example.com",
        status: "failed",
        error: "resend 500",
      },
      { kind: "magic_link", recipient: "member@example.com", status: "sent" },
    ]);
    const page = await (await w.fetch(get(`/people/${memberId}`, leadCookie))).text();
    expect(page).toContain("Email failed to send: RSVP nudge (resend 500)");
    expect(page).not.toContain("Sign-in link");
  });

  it("shows a Lead the Stewards Sale list, and the old buyers page is gone", async () => {
    const res = await w.fetch(get("/tickets", leadCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Buying through the camp");
    expect((await w.fetch(get("/tickets/buyers", leadCookie))).status).toBe(404);
  });

  it("shows a Lead the people list, including contact details", async () => {
    const res = await w.fetch(get("/people", leadCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Plain Member");
    expect(html).toContain("member@example.com");
  });

  it("lets a Lead add and invite a person", async () => {
    const before = w.emails.length;
    const res = await w.fetch(
      post(
        "/people/new",
        { legalName: "Fresh Face", email: "Fresh@Example.com", invite: "on" },
        { cookie: leadCookie },
      ),
    );
    expect(res.status).toBe(302);
    const [p] = await t.db.select().from(person).where(eq(person.email, "fresh@example.com"));
    expect(p.legalName).toBe("Fresh Face");
    const invites = await t.db.select().from(invite).where(eq(invite.personId, p.id));
    expect(invites[0]?.status).toBe("pending");
    expect(w.emails.slice(before).map((e) => e.to)).toEqual(["fresh@example.com"]);
    expect(w.emails.at(-1)?.text).toContain("/sign-in?email=fresh%40example.com");
  });

  it("won't add a second person with an existing active person's email", async () => {
    const res = await w.fetch(
      post(
        "/people/new",
        { legalName: "Plain Again", email: "MEMBER@example.com", invite: "on" },
        { cookie: leadCookie },
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("already has this email");
    expect(html).toContain(`/people/${memberId}`);
    expect(html).toContain('value="Plain Again"');
    expect(
      await t.db.select().from(person).where(eq(person.email, "member@example.com")),
    ).toHaveLength(1);
  });

  it("warns about a deactivated match, and adds anyway only when confirmed", async () => {
    const [old] = await t.db
      .insert(person)
      .values({ legalName: "Old Dupe", email: "dupe@example.com", active: false })
      .returning();
    const first = await w.fetch(
      post(
        "/people/new",
        { legalName: "New Dupe", email: "dupe@example.com" },
        { cookie: leadCookie },
      ),
    );
    const html = await first.text();
    expect(html).toContain("is deactivated");
    expect(html).toContain("Add a new person anyway");
    const again = await w.fetch(
      post(
        "/people/new",
        { legalName: "New Dupe", email: "dupe@example.com", allowInactiveMatch: old.id },
        { cookie: leadCookie },
      ),
    );
    expect(again.status).toBe(302);
    expect(
      await t.db.select().from(person).where(eq(person.email, "dupe@example.com")),
    ).toHaveLength(2);
  });

  // Issue #93 (R6): only Admins give roles.
  it("tells a Lead only an Admin can give a role", async () => {
    const res = await w.fetch(
      post(`/people/${memberId}`, { intent: "grant", role: "lead" }, { cookie: leadCookie }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Only an Admin can do that.");
    expect(
      await t.db.select().from(memberRole).where(eq(memberRole.personId, memberId)),
    ).toHaveLength(0);
  });

  it("returns 404 for an unknown person", async () => {
    const res = await w.fetch(get("/people/00000000-0000-0000-0000-000000000000", leadCookie));
    expect(res.status).toBe(404);
  });
});
