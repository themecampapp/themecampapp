// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campSettings, memberRole } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #62: on phones, the signed-in header's links live in a Menu (app/components/
// MobileMenu.tsx), grouped, with the same links the wider header shows.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  await t.db.update(campSettings).set({ featureVolunteer: true, featureJoin: true });
  for (const [key, roles] of [
    ["member", []],
    ["lead", ["lead"]],
    ["admin", ["admin", "lead"]],
  ] as const) {
    const p = await invitePerson(t, `${key}@example.com`, { legalName: `${key} Person` });
    for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[key] = await signIn(w, `${key}@example.com`);
  }
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

// The menu's groups and their links, in order.
async function menu(who: string) {
  const html = await (await w.fetch(get("/", cookie[who]))).text();
  const nav = html.match(/<nav aria-label="Menu"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const groups = [...nav.matchAll(/<p[^>]*>([^<]+)<\/p>\s*<ul>([\s\S]*?)<\/ul>/g)].map((m) => [
    m[1],
    [...m[2].matchAll(/>([^<>]+)<\/a>/g)].map((a) => a[1]),
  ]);
  return { html, nav, groups: Object.fromEntries(groups) as Record<string, string[]> };
}

describe("the phone menu", () => {
  it("gives a member their own pages and Sign out, nothing for Leads", async () => {
    const { html, nav, groups } = await menu("member");
    expect(html).toContain("Menu</summary>");
    expect(groups).toEqual({
      You: ["Home", "Profile", "Yearbook", "Directory", "Volunteer", "Guides"],
    });
    expect(nav).toContain('action="/sign-out"');
  });

  it("adds the camp leads' pages for a Lead, and Admin for an Admin", async () => {
    const lead = (await menu("lead")).groups;
    expect(lead["Camp leads"]).toEqual(
      expect.arrayContaining(["Roster", "Tickets", "People", "Queue", "Announcements", "Dates"]),
    );
    expect(lead.Admin).toBeUndefined();
    expect((await menu("admin")).groups.Admin).toEqual(["Admin"]);
  });

  it("is hidden on wider screens, where the header shows the links", async () => {
    const { html } = await menu("lead");
    expect(html).toMatch(/<details[^>]*class="group md:hidden"/);
    expect(html).toMatch(/class="hidden items-center gap-3 text-sm md:flex"/);
    expect(html).toMatch(
      /aria-label="Lead"[^>]*class="[^"]*hidden[^"]*md:flex|class="[^"]*hidden[^"]*md:flex[^"]*"[^>]*aria-label="Lead"/,
    );
  });
});
