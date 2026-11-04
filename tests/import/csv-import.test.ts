// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  burn,
  campSettings,
  importBatch,
  importRecord,
  memberRole,
  participation,
  person,
} from "~/db/schema";
import { readPeopleCsv } from "~/lib/data/csv-import.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import {
  get,
  invitePerson,
  post,
  signIn,
  startWorker,
  type TestWorker,
  upload,
} from "../helpers/worker";

// R31–R33: a Lead imports people from a CSV file, with a preview first.

let t: TestDb;
let z: Zulu;
let w: TestWorker;
let lead: string;
let leadId: string;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  leadId = l.id;
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  await w.fetch(get("/", lead));
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`delete from import_record`;
  await t.client`delete from import_batch`;
  // Only the test camp's: the other camp must stay as it was.
  await t.client`delete from participation where camp_id = ${t.campId} and person_id <> ${leadId}`;
  await t.client`delete from audit_log where camp_id = ${t.campId}`;
  await t.client`delete from invite where camp_id = ${t.campId} and person_id <> ${leadId}`;
  await t.client`delete from member_role where camp_id = ${t.campId} and person_id <> ${leadId}`;
  await t.client`delete from person where id <> ${leadId} and camp_id = ${t.campId}`;
});

const csv = (lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
const HEADER = "Name,Playa name,Email,Phone,Home location,Past years attended";

// Uploads a file; returns the preview's batch id and page, or the refusal.
async function preview(bytes: Uint8Array, name = "people.csv", type = "text/csv") {
  const res = await w.fetch(
    upload("/people/import", { intent: "upload" }, { name, type, bytes }, lead, "file"),
  );
  if (res.status !== 302) return { error: await res.text() };
  const batch = new URL(res.headers.get("location") ?? "", "https://x").searchParams.get("batch");
  await res.text();
  const page = await (await w.fetch(get(`/people/import?batch=${batch}`, lead))).text();
  return { batch: batch as string, page };
}
async function confirm(batch: string, choices: Record<string, string> = {}) {
  const res = await w.fetch(
    post("/people/import", { intent: "apply", batch, ...choices }, { cookie: lead }),
  );
  expect(res.status).toBe(302);
  await res.text();
  return (await w.fetch(get(`/people/import?batch=${batch}`, lead))).text();
}
const people = () =>
  t.db
    .select()
    .from(person)
    .where(sql`${person.campId} = ${t.campId} and ${person.id} <> ${leadId}`);

describe("importing people from a CSV file", () => {
  it.each(["admin", "treasurer"] as const)(
    "refuses to fill a %s's missing sign-in email and rolls back the batch",
    async (role) => {
      const [target] = await t.db
        .insert(person)
        .values({ legalName: "Privileged Existing" })
        .returning();
      await t.db.insert(memberRole).values({ personId: target.id, role });
      const p = await preview(
        csv([
          HEADER,
          "New Camper,,new@example.com,,,2024",
          "Privileged Existing,,attacker@example.com,,,2024",
        ]),
      );
      if ("error" in p) throw new Error(p.error);
      const response = await w.fetch(
        post(
          "/people/import",
          {
            intent: "apply",
            batch: p.batch,
            row_3: "update",
          },
          { cookie: lead },
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        role === "admin" ? "Only an Admin" : "This person can do things you can",
      );
      expect((await people()).map((p) => p.id)).toEqual([target.id]);
      expect((await people())[0].email).toBeNull();
      expect(await t.db.select().from(importRecord)).toHaveLength(0);
      expect((await t.db.select().from(importBatch))[0].status).toBe("pending");
      expect(await t.db.select().from(auditLog).where(eq(auditLog.campId, t.campId))).toHaveLength(
        0,
      );
    },
  );

  it("still lets a Lead update a privileged person's details without changing their email", async () => {
    const [target] = await t.db
      .insert(person)
      .values({ legalName: "Privileged Existing" })
      .returning();
    await t.db.insert(memberRole).values({ personId: target.id, role: "admin" });
    const p = await preview(csv([HEADER, "Privileged Existing,Sparky,,555-111-2222,,2024"]));
    if ("error" in p) throw new Error(p.error);
    await confirm(p.batch, { row_2: "update" });
    expect((await people())[0]).toMatchObject({ id: target.id, email: null, playaName: "Sparky" });
  });

  it("previews 20 clean rows, then adds all 20 with their past years, as one audited batch", async () => {
    const zuluBefore =
      await t.client`select count(*)::int as n from person where camp_id = ${z.campId}`;
    const rows = Array.from(
      { length: 20 },
      (_, i) =>
        `Camper ${i + 1},Sparky${i + 1},c${i + 1}@example.com,555-555-01${String(i).padStart(2, "0")},"Oakland, CA","2019, 2025"`,
    );
    const p = await preview(csv([HEADER, ...rows]));
    if ("error" in p) throw new Error(p.error);
    expect(p.page).toContain("New people (20)");
    // Nothing saved yet.
    expect(await people()).toHaveLength(0);

    const done = await confirm(p.batch);
    expect(done).toContain("20 added, 0 updated, 0 skipped");
    const added = await people();
    expect(added).toHaveLength(20);
    const c1 = added.find((x) => x.email === "c1@example.com");
    expect(c1).toMatchObject({
      legalName: "Camper 1",
      playaName: "Sparky1",
      homeLocation: "Oakland, CA",
    });
    // Past years: 2025 already a season; 2019 made for it. Both attended.
    const years = await t.client`
      select b.year from participation pa join burn b on b.id = pa.burn_id
      where pa.person_id = ${c1?.id ?? ""} and pa.attended order by 1`;
    expect(years.map((y) => y.year)).toEqual([2019, 2025]);
    expect(await t.db.select().from(burn).where(eq(burn.year, 2019))).toHaveLength(1);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.campId, t.campId));
    expect(audits.map((a) => a.action)).toEqual(["people_imported"]);
    expect(audits[0].after).toMatchObject({ created: 20, updated: 0 });
    // The batch keeps only its counts once applied.
    const [b] = await t.db.select().from(importBatch);
    expect(b.status).toBe("applied");
    expect(b.rows).toBeNull();
    // The other camp is untouched.
    const zuluAfter =
      await t.client`select count(*)::int as n from person where camp_id = ${z.campId}`;
    expect(zuluAfter[0].n).toBe(zuluBefore[0].n);

    // The same file again adds nobody.
    const again = await preview(csv([HEADER, ...rows]));
    if ("error" in again) throw new Error(again.error);
    expect(again.page).toContain("New people (0)");
    expect(again.page).toContain("already imported from a file before");
    expect(await confirm(again.batch)).toContain("0 added, 0 updated, 20 skipped");
    expect(await people()).toHaveLength(20);
  });

  it("offers skip or update for someone already in the app, and does what's chosen", async () => {
    const [ada] = await t.db
      .insert(person)
      .values({ legalName: "Ada Existing", email: "ada@example.com", phone: "555-000-0000" })
      .returning();
    const [bo] = await t.db
      .insert(person)
      .values({ legalName: "Bo Existing", email: "bo@example.com" })
      .returning();
    const p = await preview(
      csv([
        HEADER,
        "Ada Lovelace,Countess,ADA@example.com,555-111-2222,London,2024",
        "Bo Newname,,bo@example.com,555-333-4444,,",
      ]),
    );
    if ("error" in p) throw new Error(p.error);
    expect(p.page).toContain("Probably already here (2)");
    expect(p.page).toContain("(same email)");

    await confirm(p.batch, { row_2: "update", row_3: "skip" });
    const [a] = await t.db.select().from(person).where(eq(person.id, ada.id));
    expect(a).toMatchObject({
      legalName: "Ada Lovelace",
      playaName: "Countess",
      phone: "555-111-2222",
      homeLocation: "London",
      email: "ada@example.com",
    });
    const [b] = await t.db.select().from(person).where(eq(person.id, bo.id));
    expect(b.legalName).toBe("Bo Existing");
    expect(await people()).toHaveLength(2);
    const [pa] = await t.db.select().from(participation).where(eq(participation.personId, ada.id));
    expect(pa.attended).toBe(true);
  });

  it("imports two rows sharing an email, and neither can be invited until fixed", async () => {
    const p = await preview(
      csv([
        HEADER,
        "Pat One,,couple@example.com,,,",
        "Sam Two,,couple@example.com,,,",
        "No Email,,,,,",
      ]),
    );
    if ("error" in p) throw new Error(p.error);
    expect(p.page).toContain("Shared with another row");
    const done = await confirm(p.batch);
    expect(done).toContain("3 added");
    expect(done).toContain("Not ready to invite yet (3)");
    expect(done).toContain("shares an email with someone else");
    expect(done).toContain("No Email</a>: no email");
    const [pat] = await t.db.select().from(person).where(eq(person.legalName, "Pat One"));
    const res = await w.fetch(post(`/people/${pat.id}`, { intent: "invite" }, { cookie: lead }));
    expect(await res.text()).toMatch(/share|same email/i);
  });

  it("leaves a bad phone or email blank and flags it, and skips a row with no name", async () => {
    const p = await preview(
      csv([HEADER, "Val Bad,,not-an-email,call me,,2031 2024", ",,nobody@example.com,,,"]),
    );
    if ("error" in p) throw new Error(p.error);
    expect(p.page).toContain("Check these (1)");
    expect(p.page).toContain("&quot;call me&quot; isn&#x27;t a phone number");
    expect(p.page).toContain("&quot;not-an-email&quot; isn&#x27;t an email address");
    expect(p.page).toContain("Left out of past years: 2031");
    expect(p.page).toContain("Row 3: no name.");
    expect(await confirm(p.batch)).toContain("1 added, 0 updated, 1 skipped");
    const [val] = await people();
    expect(val).toMatchObject({ legalName: "Val Bad", email: null, phone: null });
  });

  it("refuses a file that isn't a CSV, or is too big, before any preview", async () => {
    const png = await preview(
      new Uint8Array([137, 80, 78, 71, 0, 0, 0, 13]),
      "photo.png",
      "image/png",
    );
    expect("error" in png && png.error).toContain("doesn&#x27;t look like a CSV file");
    const binary = await preview(new Uint8Array([78, 97, 109, 101, 10, 0, 1, 2]));
    expect("error" in binary && binary.error).toContain("doesn&#x27;t look like a CSV file");
    const big = await preview(csv([HEADER, `A,${"x".repeat(1_000_001)}`]));
    expect("error" in big && big.error).toContain("over 1 MB");
    const noName = await preview(csv(["Email", "a@example.com"]));
    expect("error" in noName && noName.error).toContain("needs a &quot;Name&quot; column");
    expect(await t.db.select().from(importBatch)).toHaveLength(0);
  });

  it("can be cancelled, and nothing is saved", async () => {
    const p = await preview(csv([HEADER, "Cal Cancel,,cal@example.com,,,"]));
    if ("error" in p) throw new Error(p.error);
    const res = await w.fetch(
      post("/people/import", { intent: "cancel", batch: p.batch }, { cookie: lead }),
    );
    expect(res.status).toBe(302);
    await res.text();
    expect(await t.db.select().from(importBatch)).toHaveLength(0);
    expect(await people()).toHaveLength(0);
    expect(await t.db.select().from(importRecord)).toHaveLength(0);
  });

  it("offers the template", async () => {
    const res = await w.fetch(get("/people/import/template", lead));
    expect(res.headers.get("Content-Disposition")).toContain("people-import-template.csv");
    expect(await res.text()).toContain(
      "Name,Playa name,Email,Phone,Home location,Past years attended",
    );
  });
});

describe("mailing addresses in the import (issue #78)", () => {
  const ADDR_HEADER = "Name,Email,Home location,Street address,Apt,City,State,Zip,Country";
  const mailingOn = (on: boolean) => t.db.update(campSettings).set({ featureMailing: on });
  afterAll(() => mailingOn(false));

  it("reads the address columns only for a camp that collects them", async () => {
    const text = "Name,Street address,City,State,Zip\r\nAmy,1 Main St,Reno,NV,89501\r\n";
    const [off] = await readPeopleCsv(text, 2026);
    expect(off).toMatchObject({ homeLocation: "Reno", mailingAddress: null });
    const [on] = await readPeopleCsv(text, 2026, { mailing: true });
    expect(on.homeLocation).toBeNull(); // "City" is the address's now
    expect(on.mailingAddress).toEqual({
      line1: "1 Main St",
      line2: null,
      city: "Reno",
      region: "NV",
      postalCode: "89501",
      country: "United States",
    });
    expect(on.flags).toContain(
      "The mailing address has no country, so it's set to United States (from the ZIP code).",
    );
    // Without a street column, "City" is still the home location.
    const [noStreet] = await readPeopleCsv("Name,City\r\nBo,Reno\r\n", 2026, { mailing: true });
    expect(noStreet).toMatchObject({ homeLocation: "Reno", mailingAddress: null });
    // Both a home location and an address city.
    const [both] = await readPeopleCsv(
      "Name,City,Home location,Address,Country\r\nCy,Paris,Lyon,1 Rue X,France\r\n",
      2026,
      { mailing: true },
    );
    expect(both.homeLocation).toBe("Lyon");
    expect(both.mailingAddress).toMatchObject({
      line1: "1 Rue X",
      city: "Paris",
      country: "France",
    });
  });

  it("leaves out an incomplete address with a flag, keeping the rest of the row", async () => {
    const [r] = await readPeopleCsv(
      "Name,Phone,Street,City\r\nDee,555-555-0123,1 Main St,Reno\r\n",
      2026,
      {
        mailing: true,
      },
    );
    expect(r).toMatchObject({ phone: "555-555-0123", mailingAddress: null });
    expect(r.flags).toContain(
      "The mailing address needs at least a street, a city and a country, so it's left out.",
    );
  });

  it("adds people with their addresses, shows them first, and fills in someone's missing one", async () => {
    await mailingOn(true);
    const [ada] = await t.db
      .insert(person)
      .values({ legalName: "Ada Existing", email: "ada@example.com" })
      .returning();
    const p = await preview(
      csv([
        ADDR_HEADER,
        "New Camper,new@example.com,Reno,1 Main St,Apt 2,Reno,NV,89501,USA",
        "Ada Existing,ada@example.com,,9 Elm St,,Bristol,,BS1 4ST,UK",
      ]),
    );
    if ("error" in p) throw new Error(p.error);
    expect(p.page).toContain("Mailing address");
    expect(p.page).toContain("Reno, NV 89501");
    await confirm(p.batch, { row_3: "update" });
    const rows = await people();
    expect(rows.find((x) => x.legalName === "New Camper")?.mailingAddress).toMatchObject({
      line1: "1 Main St",
      line2: "Apt 2",
      country: "USA",
    });
    expect(rows.find((x) => x.id === ada.id)?.mailingAddress).toMatchObject({
      line1: "9 Elm St",
      city: "Bristol",
      country: "UK",
    });
    const [{ kind }] = await t.client`
      select jsonb_typeof(mailing_address) as kind from person where id = ${ada.id}`;
    expect(kind).toBe("object");
  });

  it("keeps someone's address when the row being imported has none", async () => {
    await mailingOn(true);
    const kept = {
      line1: "5 Oak St",
      line2: null,
      city: "Reno",
      region: null,
      postalCode: null,
      country: "USA",
    };
    const [bo] = await t.db
      .insert(person)
      .values({ legalName: "Bo Existing", email: "bo@example.com", mailingAddress: kept })
      .returning();
    const p = await preview(csv([HEADER, "Bo Existing,Bobo,bo@example.com,,,"]));
    if ("error" in p) throw new Error(p.error);
    await confirm(p.batch, { row_2: "update" });
    const [b] = await t.db.select().from(person).where(eq(person.id, bo.id));
    expect(b).toMatchObject({ playaName: "Bobo", mailingAddress: kept });
  });

  it("imports the people export back, addresses and all", async () => {
    await mailingOn(true);
    await t.db.insert(person).values({
      legalName: "Eve Exported",
      email: "eve@example.com",
      mailingAddress: {
        line1: "7 Pine Rd",
        line2: "Unit 3",
        city: "Bend",
        region: "OR",
        postalCode: "97701",
        country: "USA",
      },
    });
    const exported = await (await w.fetch(get("/people/export", lead))).text();
    await t.client`delete from person where legal_name = 'Eve Exported'`;
    const p = await preview(new TextEncoder().encode(exported));
    if ("error" in p) throw new Error(p.error);
    await confirm(p.batch);
    const eve = (await people()).find((x) => x.legalName === "Eve Exported");
    expect(eve?.mailingAddress).toEqual({
      line1: "7 Pine Rd",
      line2: "Unit 3",
      city: "Bend",
      region: "OR",
      postalCode: "97701",
      country: "USA",
    });
  });

  it("has address columns in the template only while the camp collects them", async () => {
    await mailingOn(false);
    expect(await (await w.fetch(get("/people/import/template", lead))).text()).not.toContain(
      "Street address",
    );
    await mailingOn(true);
    const on = await (await w.fetch(get("/people/import/template", lead))).text();
    expect(on).toContain("Street address,Apartment or unit,City,State,ZIP or postal code,Country");
    expect(await (await w.fetch(get("/people/import", lead))).text()).toContain(
      "optional mailing address",
    );
  });
});
