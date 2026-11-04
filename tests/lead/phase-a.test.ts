// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  burn,
  memberRole,
  participation,
  person,
  ticketRequest,
  volunteerRole,
  volunteerSignup,
} from "~/db/schema";
import { backLink } from "~/lib/back-link";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// The Lead workspace plan, Phase A (docs/plans/2026-09-30-001-feat-lead-workspace-ux-plan.md):
// exact count links, exception-first boards, readable labels, and back links that remember
// the list.

let t: TestDb;
let w: TestWorker;
let lead: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead", playaName: "Lee" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  await w.fetch(get("/", lead));

  const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  const camper = async (key: string, intent: "going" | "leaning_yes" | null, extra = {}) => {
    const p = await invitePerson(t, `${key.toLowerCase()}@example.com`, {
      legalName: `${key} Person`,
      playaName: key,
    });
    ids[key] = p.id;
    if (!intent) return null;
    const [pa] = await t.db
      .insert(participation)
      .values({ personId: p.id, burnId: season.id, intent, ...extra })
      .returning();
    return pa;
  };
  const gus = await camper("Gus", "going", { sapRequested: true, sapDate: "2027-08-24" });
  const gia = await camper("Gia", "going");
  await camper("Gil", "going");
  await camper("Lyn", "leaning_yes");
  const lou = await camper("Lou", "leaning_yes");
  await camper("Nia", null);
  await t.db.insert(ticketRequest).values([
    { participationId: gus?.id as string, ticketsNeeded: 2 },
    { participationId: gia?.id as string, ticketsNeeded: 0, hasTicketElsewhere: true },
    { participationId: lou?.id as string, ticketsNeeded: 1 },
  ]);
  // Gus fills a one-slot role.
  const [coordinator] = await t.db
    .select()
    .from(volunteerRole)
    .where(eq(volunteerRole.title, "Volunteer Coordinator"));
  await t.db
    .insert(volunteerSignup)
    .values({ burnId: season.id, roleId: coordinator.id, personId: ids.Gus });
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const page = async (path: string) => (await w.fetch(get(path, lead))).text();
const at = (html: string, text: string) => html.indexOf(text);

describe("counts open exactly their rows (Unit 1)", () => {
  it("links each roster count to its own list", async () => {
    const html = await page("/roster");
    for (const href of [
      "/roster?rsvp=going",
      "/roster?rsvp=leaning_yes",
      "/roster?rsvp=leaning_no",
      "/roster?rsvp=not_going",
      "/roster?preset=no-rsvp",
      "/roster?preset=missing-ticket",
      "/tickets?show=buying",
    ]) {
      expect(html, href).toContain(`href="${href}"`);
    }
  });

  it("lists only that answer, with a way back to everyone", async () => {
    const going = await page("/roster?rsvp=going");
    for (const name of ["Gus", "Gia", "Gil"]) expect(going).toContain(`>${name}<`);
    expect(going).not.toContain(">Lyn<");
    expect(going).toContain(">Clear filters<");
    // The old address still works: it goes to the new one.
    const old = await w.fetch(get("/roster?view=going", lead));
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/roster?rsvp=going");
    await old.text();
    const yes = await page("/roster?rsvp=leaning_yes");
    expect(yes).toContain(">Lyn<");
    expect(yes).not.toContain(">Gus<");
  });

  it("marks the selected tab, and falls back to Everyone for an unknown view", async () => {
    const html = await page("/roster?preset=bogus");
    expect(html).toMatch(/aria-current="page"[^>]*>Everyone/);
    expect(html).toContain(">Gus<");
  });

  it("shows how many people match on People, with a way to clear the filters", async () => {
    const html = await page("/people?status=invited");
    expect(html).toMatch(/aria-current="page"[^>]*>Invited/);
    expect(html).toMatch(/\d+ (people|person) · /);
    expect(html).toContain(">Clear filters<");
  });
});

describe("work to do comes first (Unit 2)", () => {
  it("puts campers with no ticket request first, and narrows to one group or a name", async () => {
    const all = await page("/tickets");
    expect(at(all, "Coming, no request yet")).toBeLessThan(at(all, "Buying through the camp"));
    const missing = await page("/tickets?show=missing");
    expect(missing).toContain(">Gil<");
    expect(missing).toContain(">Lyn<");
    expect(missing).not.toContain("Buying through the camp");
    const gus = await page("/tickets?q=gus");
    expect(gus).toContain(">Gus<");
    expect(gus).not.toContain(">Lou<");
  });

  it("offers 'approve day; pass later' when there are no passes, without an empty pass picker", async () => {
    const html = await page("/saps");
    expect(html).toContain("no passes left that day");
    expect(html).toContain("Approve day; pass later");
    expect(html).not.toContain('aria-label="Pass"');
  });

  it("lists roles that need people first, and who's coming without a role", async () => {
    const manage = await page("/volunteers");
    expect(at(manage, "Logistics/Infrastructure Lead")).toBeLessThan(
      at(manage, "Volunteer Coordinator"),
    );
    const staffing = manage.slice(at(manage, "Staffing"), at(manage, "Staffing") + 2000);
    expect(staffing).toContain(">Gil<");
    expect(staffing).toContain(">Lyn<");
    expect(staffing).not.toContain(">Gus<");
    const member = await page("/volunteer");
    expect(at(member, "Logistics/Infrastructure Lead")).toBeLessThan(
      at(member, "Volunteer Coordinator"),
    );
  });

  it("opens the Directory when no one has a photo, and finds people by the names it shows", async () => {
    const yearbook = await page("/yearbook");
    expect(yearbook).toMatch(/aria-current="page"[^>]*>Directory</);
    const found = await page("/yearbook?view=directory&q=gil");
    expect(found).toContain("Gil");
    expect(found).not.toContain("Lyn");
    // For a member, a full name its owner chose to hide isn't searchable. (Leads see every
    // contact, so they can find it.)
    await t.db.update(person).set({ directoryHidden: true }).where(eq(person.id, ids.Gil));
    const member = await signIn(w, "lyn@example.com");
    await w.fetch(get("/", member));
    const hidden = await (
      await w.fetch(get("/yearbook?view=directory&q=gil%20person", member))
    ).text();
    expect(hidden).not.toContain("Gil Person");
    expect(hidden).not.toMatch(/"label\\?",\\?"Gil\\?"/);
    const byName = await (await w.fetch(get("/yearbook?view=directory&q=gil", member))).text();
    expect(byName).toContain(">Gil<");
    await t.db.update(person).set({ directoryHidden: false }).where(eq(person.id, ids.Gil));
  });
});

describe("back links remember the list (Unit 4)", () => {
  it("accepts only a Lead list on this site", () => {
    expect(backLink("/roster?view=missing")).toEqual({
      to: "/roster?view=missing",
      label: "Roster",
    });
    expect(backLink("/inquiries/abc")).toEqual({ to: "/inquiries/abc", label: "Inquiries" });
    for (const bad of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "/admin/settings",
      "javascript:alert(1)",
      "",
      null,
    ]) {
      expect(backLink(bad), String(bad)).toEqual({ to: "/people", label: "People" });
    }
  });

  it("goes back to the filtered list, even after saving on the person page", async () => {
    // From the roster, a person opens beside the list; "Edit record" remembers both.
    const roster = await page("/roster?preset=no-rsvp");
    expect(roster).toContain(`href="/roster/${ids.Nia}?preset=no-rsvp"`);
    const panel = await page(`/roster/${ids.Nia}?preset=no-rsvp`);
    const from = `/roster/${ids.Nia}?preset=no-rsvp`;
    expect(panel).toContain(`href="/people/${ids.Nia}?back=${encodeURIComponent(from)}"`);
    const back = `back=${encodeURIComponent(from)}`;
    const person = await page(`/people/${ids.Nia}?${back}`);
    expect(person).toContain(`href="${from}"`);
    expect(person).toContain("← Roster");

    const saved = await w.fetch(
      post(
        `/people/${ids.Nia}?${back}`,
        { intent: "update", legalName: "Nia Person" },
        { cookie: lead },
      ),
    );
    expect(saved.status).toBe(302);
    expect(saved.headers.get("location")).toContain(back);
    await saved.text();
  });

  it("falls back to People for anywhere else", async () => {
    const person = await page(
      `/people/${ids.Nia}?back=${encodeURIComponent("https://evil.example/")}`,
    );
    expect(person).toContain("← People");
    expect(person).not.toMatch(/href="[^"]*evil\.example/);
  });
});
