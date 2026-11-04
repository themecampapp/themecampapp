// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, memberRole, participation, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let season: string;
const cookie: Record<string, string> = {};
const DIR = "/yearbook?view=directory";

async function going(personId: string, intent: "going" | "leaning_yes" | "leaning_no" = "going") {
  await t.db.insert(participation).values({
    personId,
    burnId: season,
    intent,
    arrivalDate: "2027-08-23",
    dwellingDescription: "Secret Bus",
  });
}

async function member(key: string, values: Partial<typeof person.$inferInsert>) {
  const p = await invitePerson(t, `${key}@example.com`, values);
  cookie[key] = await signIn(w, `${key}@example.com`);
  await w.fetch(get("/", cookie[key])); // first visit links the login
  return p;
}

const choose = (key: string, share: "yes" | "no", next?: string) =>
  w.fetch(
    post(
      "/profile",
      { intent: "directory", share, ...(next ? { next } : {}) },
      { cookie: cookie[key] },
    ),
  );

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  [{ id: season }] = await t.db.select({ id: burn.id }).from(burn).where(eq(burn.year, 2027));

  const viewer = await member("viewer", { legalName: "Vic Viewer", playaName: "Looker" });
  await going(viewer.id);
  const sharer = await member("sharer", {
    legalName: "Sam Sharerson",
    playaName: "Sparky",
    phone: "5550001111",
    homeLocation: "Oaklandia",
    note2026: "Lead-only note",
  });
  await going(sharer.id, "leaning_yes");
  await choose("sharer", "yes");
  const hider = await member("hider", {
    legalName: "Hal Hiderson",
    playaName: "Ghost",
    phone: "5550002222",
    homeLocation: "Hidetown",
  });
  await going(hider.id);
  await choose("hider", "no");
  const undecided = await member("undecided", {
    legalName: "Uma Undecidedson",
    phone: "5550003333",
  });
  await going(undecided.id);
  // Imported and set to Going by a Lead, but never signed in.
  const [imported] = await t.db
    .insert(person)
    .values({
      legalName: "Ian Importedson",
      email: "imported@example.com",
      phone: "5550004444",
      homeLocation: "Importville",
    })
    .returning();
  await going(imported.id);
  const away = await member("away", { legalName: "Ava Awayson", playaName: "Elsewhere" });
  await going(away.id, "leaning_no");
  await choose("away", "yes");
  const lead = await member("lead", { legalName: "Lee Lead", playaName: "Captain" });
  await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("camp directory through the real Worker", () => {
  it("shows everyone coming, with contacts only for those who chose to share", async () => {
    const res = await w.fetch(get(DIR, cookie.viewer));
    expect(res.status).toBe(200);
    const html = await res.text();
    // Shared: full name, email and phone.
    expect(html).toContain("Sparky");
    expect(html).toContain("Sam Sharerson");
    expect(html).toContain("mailto:sharer@example.com");
    expect(html).toContain("5550001111");
    // Hidden, undecided, and imported-never-signed-in: Yearbook name only.
    expect(html).toContain("Ghost");
    expect(html).toContain("Uma");
    expect(html).toContain("Ian");
    expect(html).toContain("Contact hidden");
    for (const leak of [
      "hider@example.com",
      "5550002222",
      "Hiderson",
      "undecided@example.com",
      "5550003333",
      "Undecidedson",
      "imported@example.com",
      "5550004444",
      "Importedson",
    ]) {
      expect(html).not.toContain(leak);
    }
    // Not coming: not listed at all.
    expect(html).not.toContain("Elsewhere");
  });

  it("shows everyone's home location, whatever their contact choice", async () => {
    const html = await (await w.fetch(get(DIR, cookie.viewer))).text();
    for (const place of ["Oaklandia", "Hidetown", "Importville"]) expect(html).toContain(place);
  });

  it("never sends logistics or notes", async () => {
    const html = await (await w.fetch(get(DIR, cookie.viewer))).text();
    for (const leak of ["Secret Bus", "2027-08-23", "Lead-only note"]) {
      expect(html).not.toContain(leak);
    }
  });

  it("shows members their own contact details even when hidden", async () => {
    const html = await (await w.fetch(get(DIR, cookie.hider))).text();
    expect(html).toContain("hider@example.com");
    expect(html).toContain("Your email and phone are hidden here.");
  });

  it("shows Leads every contact", async () => {
    const html = await (await w.fetch(get(DIR, cookie.lead))).text();
    for (const shown of ["hider@example.com", "undecided@example.com", "imported@example.com"]) {
      expect(html).toContain(shown);
    }
  });

  it("asks once on the home page, and the answer sticks", async () => {
    expect(await (await w.fetch(get("/", cookie.undecided))).text()).toContain(
      "Share your contact details with campers?",
    );
    const res = await choose("undecided", "yes", "/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?saved=directory");
    expect(await (await w.fetch(get("/", cookie.undecided))).text()).not.toContain(
      "Share your contact details with campers?",
    );
    expect(await (await w.fetch(get(DIR, cookie.viewer))).text()).toContain(
      "undecided@example.com",
    );

    // Changing your mind on the profile hides them again.
    await choose("undecided", "no");
    expect(await (await w.fetch(get(DIR, cookie.viewer))).text()).not.toContain(
      "undecided@example.com",
    );
  });

  it("isn't reachable signed out", async () => {
    const res = await w.fetch(get(DIR));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in");
  });
});
