// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLog,
  burn,
  dues,
  inquiry,
  inquiryNote,
  memberRole,
  participation,
  person,
  ticketRequest,
} from "~/db/schema";
import { csvCell } from "~/lib/data/export.server";
import { csvRecords } from "../helpers/csv";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let leadCookie: string;
let treasurerCookie: string;
let memberCookie: string;

const parse = (text: string) => csvRecords(["Name"], text);

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('Ann "Sparky", Jr')).toBe('"Ann ""Sparky"", Jr"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(2)).toBe("2");
  });

  it("defuses values a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });
});

describe("People export through the real Worker", () => {
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    const years = new Map((await t.db.select().from(burn)).map((b) => [b.year, b.id]));

    const lead = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
    await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
    leadCookie = await signIn(w, "lead@example.com");
    const treasurer = await invitePerson(t, "tia@example.com", { legalName: "Tia Treasurer" });
    await t.db.insert(memberRole).values([
      { personId: treasurer.id, role: "lead" },
      { personId: treasurer.id, role: "treasurer" },
    ]);
    treasurerCookie = await signIn(w, "tia@example.com");
    await invitePerson(t, "member@example.com", { legalName: "Mo Member" });
    memberCookie = await signIn(w, "member@example.com");
    await w.fetch(get("/", memberCookie));

    const [full] = await t.db
      .insert(person)
      .values({
        legalName: "Ann Full",
        playaName: "=Sparky",
        email: "ann@example.com",
        phone: "555-0100",
        homeLocation: "Oakland, CA",
        note2026: "Kitchen lead, 2026",
        directoryChoiceSeenAt: new Date(),
      })
      .returning();
    await t.db
      .insert(participation)
      .values({ personId: full.id, burnId: years.get(2025) as string, attended: true });
    const [pa] = await t.db
      .insert(participation)
      .values({
        personId: full.id,
        burnId: years.get(2027) as string,
        intent: "going",
        arrivalDate: "2027-08-24",
        departureDate: "2027-09-01",
        sapRequested: true,
        generator: false,
        dwellingDescription: "Tent",
      })
      .returning();
    await t.db.insert(ticketRequest).values({
      participationId: pa.id,
      ticketsNeeded: 2,
      vehiclePassNeeded: true,
      note: "one is for my partner",
    });
    await t.db.insert(dues).values({
      participationId: pa.id,
      status: "paid",
      amountCents: 15000,
      paidOn: "2027-02-01",
      method: "venmo",
    });
    const [inq] = await t.db
      .insert(inquiry)
      .values({ personId: full.id, name: "Ann Full", source: "import" })
      .returning();
    await t.db.insert(inquiryNote).values({ inquiryId: inq.id, body: "Met at Decompression" });

    const [going] = await t.db
      .insert(person)
      .values({ legalName: "Gus Going", email: "gus@example.com" })
      .returning();
    await t.db
      .insert(participation)
      .values({ personId: going.id, burnId: years.get(2027) as string, intent: "leaning_yes" });
    await t.db.insert(person).values({ legalName: "Dee Gone", active: false });
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("downloads everyone as a CSV, uncached", async () => {
    const res = await w.fetch(get("/people/export", leadCookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="testcamp-people-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const rows = parse(await res.text());
    expect(rows.map((r) => r.Name).sort()).toEqual(
      ["Ann Full", "Dee Gone", "Gus Going", "Lee Lead", "Mo Member", "Tia Treasurer"].sort(),
    );
  });

  it("leaves dues out when a Lead who isn't the Treasurer exports", async () => {
    const text = await (await w.fetch(get("/people/export", leadCookie))).text();
    const header = text.replace(/^\uFEFF/, "").split("\r\n")[0];
    expect(header).not.toMatch(/Dues/);
    expect(header).toContain("Tickets requested");
    const ann = parse(text).find((r) => r.Name === "Ann Full");
    expect(ann).toMatchObject({ Email: "ann@example.com", "Tickets requested": "2" });
    expect(Object.values(ann ?? {})).not.toContain("$150");
  });

  it("includes contact, sign-in, RSVP, camp years, tickets, dues and notes", async () => {
    const rows = parse(await (await w.fetch(get("/people/export", treasurerCookie))).text());
    const ann = rows.find((r) => r.Name === "Ann Full");
    expect(ann).toMatchObject({
      "Playa name": "'=Sparky",
      Email: "ann@example.com",
      Phone: "555-0100",
      "Home location": "Oakland, CA",
      Active: "Yes",
      "Sign-in": "Not invited",
      "Shares contact in directory": "Yes",
      "Camp years": "2025",
      "2027 RSVP": "Going",
      Arrival: "2027-08-24",
      Departure: "2027-09-01",
      "SAP requested": "Yes",
      Generator: "No",
      Dwelling: "Tent",
      "Tickets requested": "2",
      "Vehicle pass": "Yes",
      "Ticket elsewhere": "No",
      "Ticket note": "one is for my partner",
      Dues: "Paid",
      "Dues amount": "$150",
      "Dues paid on": "2027-02-01",
      "Dues method": "Venmo",
      "2026 note (Leads)": "Kitchen lead, 2026",
      "Inquiry notes": "Met at Decompression",
    });
    expect(rows.find((r) => r.Name === "Gus Going")).toMatchObject({
      "2027 RSVP": "Leaning yes",
      Dues: "Unpaid",
      "Tickets requested": "",
    });
    expect(rows.find((r) => r.Name === "Dee Gone")).toMatchObject({
      Active: "No (deactivated)",
      "2027 RSVP": "No RSVP",
      Dues: "",
    });
    expect(rows.find((r) => r.Name === "Lee Lead")).toMatchObject({
      Roles: "Lead",
      "Sign-in": "Signed in",
    });
  });

  it("audits each export", async () => {
    const before = (
      await t.db.select().from(auditLog).where(eq(auditLog.action, "people_exported"))
    ).length;
    await w.fetch(get("/people/export", leadCookie));
    const after = await t.db.select().from(auditLog).where(eq(auditLog.action, "people_exported"));
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.after).toEqual({ rows: 6, dues: false });
  });

  it("is refused to Members and signed-out visitors", async () => {
    const res = await w.fetch(get("/people/export", memberCookie));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("ann@example.com");
    const anon = await w.fetch(get("/people/export"));
    expect(anon.status).toBe(302);
  });

  it("shows the Export CSV button to Leads", async () => {
    expect(await (await w.fetch(get("/people", leadCookie))).text()).toContain("Export CSV");
  });
});
