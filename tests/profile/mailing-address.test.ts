// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { burn, campSettings, memberRole, participation, person } from "~/db/schema";
import { mailingLines, readMailingAddress } from "~/lib/mailing-address";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #78: an optional mailing address on campers' profiles, for camps that switch it on;
// only the camper, Leads and Admins see it. And a note to use their Burner Profile email.

const form = (v: Record<string, string>) => (k: string) => v[k] ?? "";

describe("reading a mailing address", () => {
  it("is nothing when every field is empty", () => {
    expect(readMailingAddress(form({ mailing_line1: "  " }))).toEqual({ address: null });
  });

  it("needs a street, city and country, tidied, the rest optional", () => {
    expect(
      readMailingAddress(
        form({ mailing_line1: " 1  Main St ", mailing_city: "Reno", mailing_country: "USA" }),
      ),
    ).toEqual({
      address: {
        line1: "1 Main St",
        line2: null,
        city: "Reno",
        region: null,
        postalCode: null,
        country: "USA",
      },
    });
    expect(readMailingAddress(form({ mailing_line1: "1 Main St", mailing_city: "Reno" }))).toEqual({
      problem: "A mailing address needs at least a street address, a city and a country.",
    });
    expect(
      readMailingAddress(
        form({ mailing_line1: "x".repeat(121), mailing_city: "Reno", mailing_country: "USA" }),
      ),
    ).toEqual({ problem: "Keep the street address under 120 characters." });
  });

  it("lays it out as on an envelope, for any country", () => {
    expect(
      mailingLines({
        line1: "1 Main St",
        line2: "Apt 2",
        city: "Reno",
        region: "NV",
        postalCode: "89501",
        country: "USA",
      }),
    ).toEqual(["1 Main St", "Apt 2", "Reno, NV 89501", "USA"]);
    expect(
      mailingLines({
        line1: "10 High St",
        line2: null,
        city: "Bristol",
        region: null,
        postalCode: "BS1 4ST",
        country: "UK",
      }),
    ).toEqual(["10 High St", "Bristol, BS1 4ST", "UK"]);
  });
});

describe("mailing addresses through the real Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  const cookie: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const ADDRESS = {
    mailing_line1: "742 Evergreen Terrace",
    mailing_line2: "",
    mailing_city: "Springfield",
    mailing_region: "OR",
    mailing_postalCode: "97477",
    mailing_country: "USA",
  };
  const details = (extra: Record<string, string> = {}) => ({
    legalName: "Amy Person",
    playaName: "Sparkle",
    phone: "",
    homeLocation: "Springfield",
    ...extra,
  });
  const saved = async () =>
    (await t.db.select({ a: person.mailingAddress }).from(person).where(eq(person.id, ids.amy)))[0]
      .a;
  const mailingOn = (on: boolean) =>
    t.db.update(campSettings).set({ featureMailing: on, featureYearbook: true });

  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    const [{ id: season }] = await t.db
      .select({ id: burn.id })
      .from(burn)
      .where(eq(burn.year, 2027));
    for (const [key, roles] of [
      ["amy", []],
      ["bo", []],
      ["lead", ["lead"]],
    ] as const) {
      const p = await invitePerson(t, `${key}@example.com`, {
        legalName: `${key === "amy" ? "Amy" : key} Person`,
      });
      ids[key] = p.id;
      for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
      await t.db.insert(participation).values({ personId: p.id, burnId: season, intent: "going" });
      cookie[key] = await signIn(w, `${key}@example.com`);
      await w.fetch(post("/privacy-notice", {}, { cookie: cookie[key] }));
    }
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });
  beforeEach(async () => {
    await mailingOn(true);
    await t.db.update(person).set({ mailingAddress: null }).where(eq(person.id, ids.amy));
  });

  const page = async (path: string, who: string) => (await w.fetch(get(path, cookie[who]))).text();
  const save = (fields: Record<string, string>, who = "amy") =>
    w.fetch(post("/profile", fields, { cookie: cookie[who] }));

  it("isn't asked for, or saved, while the camp has it off", async () => {
    await mailingOn(false);
    expect(await page("/profile", "amy")).not.toContain("Mailing address");
    await save(details(ADDRESS));
    expect(await saved()).toBeNull();
  });

  it("lets a camper add it on their profile, optional, stored as an address", async () => {
    expect(await page("/profile", "amy")).toContain("Mailing address");
    expect((await save(details())).status).toBe(302); // without one: fine
    expect(await saved()).toBeNull();
    expect((await save(details(ADDRESS))).status).toBe(302);
    expect(await saved()).toEqual({
      line1: "742 Evergreen Terrace",
      line2: null,
      city: "Springfield",
      region: "OR",
      postalCode: "97477",
      country: "USA",
    });
    // A JSON object in the database, not a string holding one.
    const [{ kind }] = await t.client`
      select jsonb_typeof(mailing_address) as kind from person where id = ${ids.amy}`;
    expect(kind).toBe("object");
    expect(await page("/profile", "amy")).toContain('value="742 Evergreen Terrace"');
  });

  it("refuses an incomplete address and keeps the old one", async () => {
    await save(details(ADDRESS));
    const res = await save(details({ ...ADDRESS, mailing_city: "" }));
    expect(await res.text()).toContain("at least a street address, a city and a country");
    expect((await saved())?.city).toBe("Springfield");
  });

  it("is removed when every field is emptied", async () => {
    await save(details(ADDRESS));
    await save(details(Object.fromEntries(Object.keys(ADDRESS).map((k) => [k, ""]))));
    expect(await saved()).toBeNull();
  });

  it("shows to Leads (person page, roster panel, export), never to other campers", async () => {
    await save(details(ADDRESS));
    expect(await page(`/people/${ids.amy}`, "lead")).toContain('value="742 Evergreen Terrace"');
    const panel = await page(`/roster/${ids.amy}`, "lead");
    expect(panel).toContain("Springfield, OR 97477");
    const csv = await page("/people/export", "lead");
    expect(csv.split("\r\n")[0]).toContain("Mailing postal code");
    expect(csv).toContain("742 Evergreen Terrace");
    for (const path of ["/yearbook?view=directory", "/yearbook?view=photos", "/"]) {
      expect(await page(path, "bo"), path).not.toContain("Evergreen");
    }
    expect((await w.fetch(get(`/people/${ids.amy}`, cookie.bo))).status).toBe(403);
  });

  it("lets a Lead fix it, and the change is in the camper's History", async () => {
    const res = await w.fetch(
      post(
        `/people/${ids.amy}`,
        { intent: "update", ...details(ADDRESS), mailing_line2: "Unit B" },
        { cookie: cookie.lead },
      ),
    );
    expect(res.status).toBe(302);
    expect((await saved())?.line2).toBe("Unit B");
    expect(await page(`/people/${ids.amy}`, "lead")).toMatch(/mailing address/i);
  });

  it("is hidden, not deleted, if the camp switches it off", async () => {
    await save(details(ADDRESS));
    await mailingOn(false);
    expect(await page(`/people/${ids.amy}`, "lead")).not.toContain("Evergreen");
    expect(await page(`/roster/${ids.amy}`, "lead")).not.toContain("Evergreen");
    expect((await page("/people/export", "lead")).split("\r\n")[0]).not.toContain("Mailing");
    await save(details()); // a profile save without the fields leaves it alone
    expect((await saved())?.line1).toBe("742 Evergreen Terrace");
  });
});

describe("the Burner Profile email note", () => {
  let t: TestDb;
  let w: TestWorker;
  let amy: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    await invitePerson(t, "amy@example.com", { legalName: "Amy Person" });
    amy = await signIn(w, "amy@example.com");
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("is on the profile by default, with the camp's name", async () => {
    const html = await (await w.fetch(get("/profile", amy))).text();
    expect(html).toContain("Please use the same email address as your Burner Profile.");
    expect(html).toContain("helps Test Camp match your ticket request");
  });

  it("can be hidden by the camp", async () => {
    await t.client`insert into app_setting (camp_id, key, value)
      values (${t.campId}, 'page_text:profile_email_hint', '""')`;
    expect(await (await w.fetch(get("/profile", amy))).text()).not.toContain("Burner Profile");
  });
});
