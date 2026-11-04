// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campSettings, guide, inquiry, memberRole } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #93: who can open which Lead page, and who can change things there, as it was before
// roles became editable. Written first against the old role checks; the move to areas must
// keep every row of it. Statuses only: what a page shows is covered by each feature's tests.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
let personId = "";
let inquiryId = "";
let guideId = "";

const VIEWERS = {
  member: [],
  lead: ["lead"],
  treasurer: ["treasurer"],
  leadTreasurer: ["lead", "treasurer"],
  admin: ["admin"],
} as const;
type Who = keyof typeof VIEWERS;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  // Every feature on, so every page exists.
  await t.db.update(campSettings).set({
    featureSaps: true,
    featureVolunteer: true,
    featureMailing: true,
  });
  for (const [who, roles] of Object.entries(VIEWERS)) {
    const email = `${who.toLowerCase()}@example.com`;
    const p = await invitePerson(t, email, { legalName: `${who} Person` });
    for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[who] = await signIn(w, email);
  }
  personId = (await invitePerson(t, "subject@example.com", { legalName: "Subject Person" })).id;
  [{ id: inquiryId }] = await t.db
    .insert(inquiry)
    .values({ name: "Curious Person", email: "curious@example.com", source: "join_form" })
    .returning({ id: inquiry.id });
  [{ id: guideId }] = await t.db
    .insert(guide)
    .values({ slug: "draft-guide", title: "Draft guide" })
    .returning({ id: guide.id });
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

// Every page under the Lead layout, and /dues, with who could open it.
const LEAD = ["lead", "leadTreasurer", "admin"] as const;
const TREASURER = ["treasurer", "leadTreasurer", "admin"] as const;
const PAGES: Array<[string, readonly Who[]]> = [
  ["/people", LEAD],
  ["/people/new", LEAD],
  ["/people/invite", LEAD],
  ["/people/export", LEAD],
  ["/people/import", LEAD],
  ["/people/import/template", LEAD],
  ["/people/:id", LEAD],
  ["/people/:id/rsvp", LEAD],
  ["/roster", LEAD],
  ["/roster/:id", LEAD],
  ["/roster/export", LEAD],
  ["/tickets", LEAD],
  ["/saps", LEAD],
  ["/volunteers", LEAD],
  ["/inquiries", LEAD],
  ["/inquiries/:inquiry", LEAD],
  ["/queue", LEAD],
  ["/announcements", LEAD],
  ["/dates", LEAD],
  ["/guide-editor", LEAD],
  ["/guide-editor/:guide", LEAD],
  ["/dues", TREASURER],
];

const url = (path: string) =>
  path.replace(":id", personId).replace(":inquiry", inquiryId).replace(":guide", guideId);

// Allowed: anything but a refusal or an error. Refused: exactly 403.
function expectOutcome(status: number, allowed: boolean, label: string) {
  if (allowed) {
    expect(status, label).not.toBe(403);
    expect(status, label).toBeLessThan(500);
  } else {
    expect(status, label).toBe(403);
  }
}

describe("who can open each Lead page (issue #93 characterization)", () => {
  for (const who of Object.keys(VIEWERS) as Who[]) {
    it(`as ${who}`, async () => {
      for (const [path, allowed] of PAGES) {
        const res = await w.fetch(get(url(path), cookie[who]));
        await res.body?.cancel();
        expectOutcome(res.status, allowed.includes(who), `${who} GET ${path}`);
      }
    });
  }

  // A client-side navigation asks for "<path>.data"; React Router also matches paths ignoring
  // case and percent-encoding. None of them may get around the checks.
  it.each([
    ["/people.data", LEAD],
    ["/roster.data", LEAD],
    ["/dues.data", TREASURER],
    ["/PEOPLE", LEAD],
    ["/Roster", LEAD],
    ["/p%65ople", LEAD],
    ["/people/", LEAD],
  ] as const)("refuses %s to everyone who can't open it", async (path, allowed) => {
    for (const who of Object.keys(VIEWERS) as Who[]) {
      const res = await w.fetch(get(path, cookie[who]));
      await res.body?.cancel();
      if (!(allowed as readonly Who[]).includes(who)) {
        expect(res.status, `${who} GET ${path}`).toBe(403);
      } else {
        expect(res.status, `${who} GET ${path}`).toBeLessThan(500);
      }
    }
  });

  it("still lets every member open their own pages", async () => {
    for (const path of ["/", "/tickets/request", "/volunteer", "/yearbook", "/profile", "/rsvp"]) {
      const res = await w.fetch(get(path, cookie.member));
      await res.body?.cancel();
      expect(res.status, `member GET ${path}`).toBe(200);
    }
  });
});

describe("who can change things in each area (issue #93 characterization)", () => {
  // One change per area. The fields needn't be valid: a refusal comes before any checking.
  const CHANGES: Array<[string, Record<string, string>, readonly Who[]]> = [
    ["/people/:id", { intent: "camp_years" }, LEAD],
    ["/people/:id/rsvp", { intent: "nonsense" }, LEAD],
    ["/roster/nudge", { personIds: "" }, LEAD],
    ["/tickets", { intent: "nonsense" }, LEAD],
    ["/saps", { intent: "nonsense" }, LEAD],
    ["/volunteers", { intent: "nonsense" }, LEAD],
    ["/inquiries/:inquiry", { intent: "nonsense" }, LEAD],
    ["/queue", { intent: "nonsense" }, LEAD],
    ["/announcements", { intent: "nonsense" }, LEAD],
    ["/dates", { intent: "nonsense" }, LEAD],
    ["/guide-editor/:guide", { intent: "nonsense" }, LEAD],
    ["/dues", { intent: "nonsense" }, TREASURER],
  ];

  for (const who of Object.keys(VIEWERS) as Who[]) {
    it(`as ${who}`, async () => {
      for (const [path, fields, allowed] of CHANGES) {
        const res = await w.fetch(post(url(path), fields, { cookie: cookie[who] }));
        await res.body?.cancel();
        expectOutcome(res.status, allowed.includes(who), `${who} POST ${path}`);
      }
    });
  }

  it("refuses a change sent as a client-side navigation too", async () => {
    const res = await w.fetch(
      post("/announcements.data", { intent: "nonsense" }, { cookie: cookie.treasurer }),
    );
    await res.body?.cancel();
    expect(res.status).toBe(403);
  });
});
