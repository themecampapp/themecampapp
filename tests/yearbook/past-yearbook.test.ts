// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, participation, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, signIn, startWorker, type TestWorker, upload } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let viewer: string; // a 2027 newcomer with no camp history
let ana: { id: string; cookie: string };
let photoPath: string;

async function camped(personId: string, year: number, extra: { intent?: "leaning_no" } = {}) {
  const [b] = await t.db.select().from(burn).where(eq(burn.year, year));
  await t.db
    .insert(participation)
    .values({ personId, burnId: b.id, attended: year < 2027 ? true : null, ...extra });
}

async function jpeg() {
  return new Uint8Array(
    await sharp({ create: { width: 600, height: 600, channels: 3, background: "#e8b931" } })
      .jpeg()
      .toBuffer(),
  );
}

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);

  await invitePerson(t, "vee@example.com", { legalName: "Vee Viewer", playaName: "Newbie" });
  viewer = await signIn(w, "vee@example.com");

  const a = await invitePerson(t, "ana@example.com", {
    legalName: "Ana Lopezsurname",
    playaName: "Sparrow",
  });
  const anaCookie = await signIn(w, "ana@example.com");
  await w.fetch(get("/", anaCookie)); // first visit links the login
  ana = { id: a.id, cookie: anaCookie };
  await w.fetch(
    upload(
      "/profile",
      { intent: "photo_upload" },
      { name: "a.jpg", type: "image/jpeg", bytes: await jpeg() },
      ana.cookie,
    ),
  );
  const [row] = await t.db.select().from(person).where(eq(person.id, ana.id));
  photoPath = `/photos/${(row.photoKey as string).split("/").pop()}`;
  await camped(ana.id, 2024);
  await camped(ana.id, 2025);
  await camped(ana.id, 2027, { intent: "leaning_no" });

  const people = await t.db
    .insert(person)
    .values([
      {
        legalName: "Ben Okafordsurname",
        playaName: "Tinker",
        email: "ben@example.com",
        phone: "5550001234",
      },
      { legalName: "Cara Smithsonsurname" },
      { legalName: "Dee Gone", playaName: "Ghostly", active: false },
      { legalName: "Eve Other", playaName: "Latecomer" },
    ])
    .returning();
  const [ben, cara, dee, eve] = people;
  for (const p of [ben, cara, dee]) await camped(p.id, 2025);
  await camped(eve.id, 2026);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("past-year Yearbooks through the real Worker", () => {
  it("shows that year's campers: photo cards with camp years, then names only", async () => {
    const res = await w.fetch(get("/yearbook/2025", viewer));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("2025 Yearbook");
    expect(html).toContain("Sparrow");
    expect(html).toContain(photoPath);
    expect(html).toContain("Camped 2024 · 2025");
    expect(html).toContain("Also in camp");
    expect(html).toContain("Tinker");
    expect(html).toContain("Cara");
  });

  it("never sends surnames, contact details, deactivated people or other years' campers", async () => {
    const html = await (await w.fetch(get("/yearbook/2025", viewer))).text();
    for (const leak of [
      "Lopezsurname",
      "Okafordsurname",
      "Smithsonsurname",
      "ben@example.com",
      "5550001234",
      "Ghostly",
      "Latecomer",
    ]) {
      expect(html).not.toContain(leak);
    }
  });

  it("links every year with campers from the current Yearbook", async () => {
    const html = await (await w.fetch(get("/yearbook", viewer))).text();
    for (const y of [2024, 2025, 2026]) expect(html).toContain(`href="/yearbook/${y}"`);
  });

  it("redirects the current year, 404s other years, and requires sign-in", async () => {
    const current = await w.fetch(get("/yearbook/2027", viewer));
    expect(current.status).toBe(302);
    expect(current.headers.get("Location")).toBe("/yearbook");
    for (const path of ["/yearbook/2030", "/yearbook/2019", "/yearbook/abc", "/yearbook/02025"]) {
      expect((await w.fetch(get(path, viewer))).status).toBe(404);
    }
    const anon = await w.fetch(get("/yearbook/2025"));
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toBe("/sign-in");
  });

  it("serves a past camper's photo to members even when they're not coming this year", async () => {
    expect((await w.fetch(get(photoPath, viewer))).status).toBe(200);
  });

  it("shows the member their own camp years on their profile", async () => {
    const html = await (await w.fetch(get("/profile", ana.cookie))).text();
    expect(html).toContain("Your camp years:");
    expect(html).toContain("2024 · 2025");
  });

  it("hides a deactivated past camper's photo and card", async () => {
    await t.db.update(person).set({ active: false }).where(eq(person.id, ana.id));
    expect((await w.fetch(get(photoPath, viewer))).status).toBe(404);
    expect(await (await w.fetch(get("/yearbook/2025", viewer))).text()).not.toContain("Sparrow");
    await t.db.update(person).set({ active: true }).where(eq(person.id, ana.id));
  });
});
