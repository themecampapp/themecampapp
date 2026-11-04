// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, burn, memberRole, participation } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #31: Admins add past seasons (back to 1996) and record who camped in them. Issue #30:
// the name in the header opens your profile.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

const page = async (path: string, who = "admin") => {
  const res = await w.fetch(get(path, cookie[who]));
  return { status: res.status, html: await res.text() };
};
const send = async (path: string, fields: Array<[string, string]>, who = "admin") => {
  const res = await w.fetch(post(path, fields, { cookie: cookie[who] }));
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
};
async function attended(personId: string, year: number) {
  const [b] = await t.db.select().from(burn).where(eq(burn.year, year));
  const [row] = await t.db
    .select({ attended: participation.attended })
    .from(participation)
    .where(and(eq(participation.personId, personId), eq(participation.burnId, b.id)));
  return row?.attended ?? null;
}

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const make = async (key: string, name: string, roles: Array<"lead" | "admin"> = []) => {
    const p = await invitePerson(t, `${key}@example.com`, {
      legalName: `${name} Person`,
      playaName: name,
    });
    ids[key] = p.id;
    for (const r of roles) await t.db.insert(memberRole).values({ personId: p.id, role: r });
    cookie[key] = await signIn(w, `${key}@example.com`);
    await w.fetch(get("/", cookie[key]));
  };
  await make("admin", "Ada", ["admin"]);
  await make("lead", "Lee", ["lead"]);
  await make("amy", "Amy");
  const gone = await invitePerson(t, "old@example.com", {
    legalName: "Olive Old",
    playaName: "Olive",
    active: false,
  });
  ids.gone = gone.id;
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("past seasons (issue #31)", () => {
  it("lets an Admin add a past season back to 1996, once", async () => {
    const added = await send("/admin", [
      ["intent", "add_past"],
      ["year", "1998"],
    ]);
    expect(added.status).toBe(302);
    expect(added.location).toMatch(/^\/admin\/seasons\/1998\?notice=/);
    expect((await page("/admin")).html).toContain('href="/admin/seasons/1998"');
    const again = await send("/admin", [
      ["intent", "add_past"],
      ["year", "1998"],
    ]);
    expect(again.html).toContain("already set up");
    for (const year of ["1995", "2027", "2030", "abc"]) {
      const res = await send("/admin", [
        ["intent", "add_past"],
        ["year", year],
      ]);
      expect(res.html, year).toContain("from 1996 up to last year");
    }
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "past_season_added"));
    expect(audits).toHaveLength(1);
  });

  it("lists everyone, people who've left too, to tick who camped", async () => {
    const { html } = await page("/admin/seasons/1998");
    expect(html).toContain("Who camped in 1998");
    expect(html).toContain("Amy (Amy Person)");
    expect(html).toContain("No longer in the camp");
    expect(html).toContain("Olive (Olive Old)");
  });

  it("records who camped, and that shows in the Yearbook and on people's pages", async () => {
    const res = await send("/admin/seasons/1998", [
      ["camped", ids.amy],
      ["camped", ids.gone],
    ]);
    expect(decodeURIComponent(res.location ?? "")).toContain("2 added, 0 taken off");
    expect(await attended(ids.amy, 1998)).toBe(true);
    expect(await attended(ids.gone, 1998)).toBe(true);
    expect((await page("/yearbook/1998", "amy")).html).toContain("Amy");
    expect((await page(`/people/${ids.amy}`, "lead")).html).toMatch(/1998/);
    expect((await page("/admin")).html).toMatch(/1998[\s\S]{0,400}2 camped/);
  });

  it("unticking takes the year off, and leaves a recorded 'didn't come' alone", async () => {
    const [b] = await t.db.select().from(burn).where(eq(burn.year, 1998));
    await t.db.insert(participation).values({ personId: ids.lead, burnId: b.id, attended: false });
    const res = await send("/admin/seasons/1998", [["camped", ids.gone]]);
    expect(decodeURIComponent(res.location ?? "")).toContain("0 added, 1 taken off");
    expect(await attended(ids.amy, 1998)).toBeNull();
    expect(await attended(ids.lead, 1998)).toBe(false);
    expect(await attended(ids.gone, 1998)).toBe(true);
  });

  it("only removes a season nobody has a record in", async () => {
    const inUse = await send("/admin", [
      ["intent", "remove_past"],
      ["year", "1998"],
    ]);
    expect(inUse.html).toContain("can&#x27;t be removed");
    await send("/admin", [
      ["intent", "add_past"],
      ["year", "2001"],
    ]);
    // Added by mistake, nobody ticked: it can go.
    const removed = await send("/admin", [
      ["intent", "remove_past"],
      ["year", "2001"],
    ]);
    expect(removed.status).toBe(302);
    expect(await t.db.select().from(burn).where(eq(burn.year, 2001))).toHaveLength(0);
  });

  it("is for Admins only, and only for past years", async () => {
    expect((await page("/admin/seasons/1998", "lead")).status).toBe(403);
    expect((await send("/admin/seasons/1998", [["camped", ids.amy]], "lead")).status).toBe(403);
    expect((await page("/admin/seasons/2027")).status).toBe(404);
    expect((await page("/admin/seasons/1999")).status).toBe(404);
  });
});

describe("the profile link (issue #30)", () => {
  it("is the member's name in the header, and 'Profile' on small screens", async () => {
    const { html } = await page("/", "amy");
    const link = html.match(/<a[^>]*href="\/profile"[^>]*>([\s\S]*?)<\/a>/);
    expect(link?.[0]).toContain('title="Your profile"');
    expect(link?.[1]).toContain('<span class="hidden sm:inline">Amy</span>');
    expect(link?.[1]).toContain('<span class="sm:hidden">Profile</span>');
  });
});
