// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, burn, memberRole, participation, sapPass, sapReview } from "~/db/schema";
import { isPdf } from "~/lib/data/sap.server";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  get,
  invitePerson,
  post,
  signIn,
  startWorker,
  type TestWorker,
  upload,
} from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`);

async function passId(serial: string) {
  const [p] = await t.db.select().from(sapPass).where(eq(sapPass.serial, serial));
  return p;
}
async function participationOf(key: string) {
  const [y] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  const [pa] = await t.db.select().from(participation).where(eq(participation.personId, ids[key]));
  expect(pa.burnId).toBe(y.id);
  return pa;
}
const mailTo = (from: number, to: string) => w.emails.slice(from).filter((e) => e.to === to);

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const make = async (key: string, name: string, roles: Array<"lead" | "admin"> = []) => {
    const p = await invitePerson(t, `${key}@example.com`, { legalName: name, playaName: name });
    ids[key] = p.id;
    for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[key] = await signIn(w, `${key}@example.com`);
    await w.fetch(get("/", cookie[key]));
  };
  await make("admin", "Ada", ["admin"]);
  await make("lead", "Lee", ["lead"]);
  await make("amy", "Amy");
  await make("bo", "Bo");
  await make("cy", "Cy");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("requesting a SAP", () => {
  it("is part of the RSVP, with the day", async () => {
    for (const [key, day] of [
      ["amy", "2027-08-24"],
      ["bo", "2027-08-25"],
    ]) {
      const res = await w.fetch(
        post(
          "/rsvp",
          { intent: "going", sapRequested: "yes", sapDate: day },
          { cookie: cookie[key] },
        ),
      );
      expect(res.status).toBe(302);
    }
    await w.fetch(post("/rsvp", { intent: "going", sapRequested: "no" }, { cookie: cookie.cy }));
    expect(await participationOf("amy")).toMatchObject({
      sapRequested: true,
      sapDate: "2027-08-24",
    });
    expect(await participationOf("cy")).toMatchObject({ sapRequested: false, sapDate: null });
    const home = await (await w.fetch(get("/", cookie.amy))).text();
    expect(home).toContain("Setup Access Pass");
    expect(home).toContain("A camp lead will review it");
  });
});

describe("SAP days", () => {
  it("offers only this season's days on the RSVP, and ignores any other", async () => {
    const html = await (await w.fetch(get("/rsvp", cookie.cy))).text();
    for (const day of ["Tuesday, August 24", "Saturday, August 28"]) expect(html).toContain(day);
    expect(html).not.toContain("Monday, August 23");
    await w.fetch(
      post(
        "/rsvp",
        { intent: "going", sapRequested: "yes", sapDate: "2027-08-30" },
        { cookie: cookie.cy },
      ),
    );
    expect(await participationOf("cy")).toMatchObject({ sapRequested: true, sapDate: null });
    await w.fetch(post("/rsvp", { intent: "going", sapRequested: "no" }, { cookie: cookie.cy }));
  });

  it("lets an Admin add and remove days, and passes must be for a listed day", async () => {
    const refused = await w.fetch(
      post(
        "/admin/saps",
        { intent: "add", date: "2027-08-30", serials: "Z-1" },
        { cookie: cookie.admin },
      ),
    );
    expect(await refused.text()).toContain("isn&#x27;t one of this season&#x27;s SAP days");
    const days = ["2027-08-24", "2027-08-25", "2027-08-26", "2027-08-27", "2027-08-28"];
    const pairs = (list: string[], extra: [string, string]) =>
      [["intent", "days"], ...list.map((d) => ["day", d]), extra] as Array<[string, string]>;
    await w.fetch(
      post("/admin/saps", pairs(days, ["addDay", "2027-08-30"]), { cookie: cookie.admin }),
    );
    const [y] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    expect(y.sapDays).toEqual([...days, "2027-08-30"]);
    await w.fetch(
      post("/admin/saps", pairs([...days, "2027-08-30"], ["removeDay", "2027-08-30"]), {
        cookie: cookie.admin,
      }),
    );
    const [after] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    expect(after.sapDays).toEqual(days);
  });
});

describe("pass stock (Admins)", () => {
  it("adds passes by day, skipping serials already in stock", async () => {
    await w.fetch(
      post(
        "/admin/saps",
        { intent: "add", date: "2027-08-24", serials: "A-1\nA-2" },
        { cookie: cookie.admin },
      ),
    );
    const res = await w.fetch(
      post(
        "/admin/saps",
        { intent: "add", date: "2027-08-25", serials: "B-1, A-1" },
        { cookie: cookie.admin },
      ),
    );
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain(
      "Added 1 pass. 1 already in stock.",
    );
    expect((await t.db.select().from(sapPass)).map((p) => p.serial).sort()).toEqual([
      "A-1",
      "A-2",
      "B-1",
    ]);
  });

  it("stores only real PDFs, privately", async () => {
    const a1 = await passId("A-1");
    const bad = await w.fetch(
      upload(
        "/admin/saps",
        { intent: "pdf", passId: a1.id },
        { name: "pass.pdf", type: "application/pdf", bytes: new TextEncoder().encode("not a pdf") },
        cookie.admin,
        "pdf",
      ),
    );
    expect(await bad.text()).toContain("That isn&#x27;t a PDF file.");
    const ok = await w.fetch(
      upload(
        "/admin/saps",
        { intent: "pdf", passId: a1.id },
        { name: "pass.pdf", type: "application/pdf", bytes: pdf("amy pass") },
        cookie.admin,
        "pdf",
      ),
    );
    expect(ok.status).toBe(302);
    const key = (await passId("A-1")).pdfKey as string;
    expect(key).toMatch(new RegExp(`^camps/${t.campId}/sap/[0-9a-f-]{36}\\.pdf$`));
    expect(isPdf(pdf("x"))).toBe(true);
  });

  it("is Admin-only", async () => {
    for (const who of ["lead", "amy"]) {
      expect((await w.fetch(get("/admin/saps", cookie[who]))).status).toBe(403);
      const res = await w.fetch(
        post(
          "/admin/saps",
          { intent: "add", date: "2027-08-23", serials: "X" },
          { cookie: cookie[who] },
        ),
      );
      expect(res.status).toBe(403);
    }
  });
});

describe("decisions (Leads)", () => {
  it("lists requests with the day asked for, and pass stock", async () => {
    const html = await (await w.fetch(get("/saps", cookie.lead))).text();
    expect(html).toContain("Waiting for a decision");
    expect(html).toContain("Amy");
    expect(html).toContain("Asked for Tue, Aug 24");
    expect(html).toContain("Tue, Aug 24: 2 of 2 left");
    expect(html).not.toContain(">Cy<");
    expect((await w.fetch(get("/saps", cookie.amy))).status).toBe(403);
  });

  it("approving with a pass that has its PDF emails 'ready', and only the holder can download it", async () => {
    const pa = await participationOf("amy");
    const a1 = await passId("A-1");
    const before = w.emails.length;
    const res = await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Amy", passId: a1.id, day: "" },
        { cookie: cookie.lead },
      ),
    );
    expect(res.status).toBe(302);
    const mails = mailTo(before, "amy@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("August 24 is ready");
    expect(mails[0].text).toContain("/sign-in?email=amy%40example.com");

    const home = await (await w.fetch(get("/", cookie.amy))).text();
    expect(home).toContain("Download your pass");
    const url = `/saps/pass/${a1.id}/pdf`;
    const dl = await w.fetch(get(url, cookie.amy));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("application/pdf");
    expect(dl.headers.get("Content-Disposition")).toContain('filename="SAP-2027-08-24-A-1.pdf"');
    expect(await dl.text()).toContain("amy pass");
    expect((await w.fetch(get(url, cookie.lead))).status).toBe(200);
    expect((await w.fetch(get(url, cookie.bo))).status).toBe(404);
    expect((await w.fetch(get(url))).status).toBe(302);
  });

  it("approving for a day emails 'approved'; the PDF arriving later emails 'ready'", async () => {
    const pa = await participationOf("bo");
    let before = w.emails.length;
    await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Bo", passId: "", day: "2027-08-25" },
        { cookie: cookie.lead },
      ),
    );
    let mails = mailTo(before, "bo@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("approved for Wednesday, August 25");
    expect(await (await w.fetch(get("/", cookie.bo))).text()).toContain(
      "We&#x27;ll email you when your pass is ready",
    );

    // Assign a pass that has no PDF yet: no new email.
    const b1 = await passId("B-1");
    before = w.emails.length;
    await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Bo", passId: b1.id, day: "" },
        { cookie: cookie.lead },
      ),
    );
    expect(mailTo(before, "bo@example.com")).toHaveLength(0);

    // The Admin uploads its PDF: Bo is told it's ready.
    before = w.emails.length;
    await w.fetch(
      upload(
        "/admin/saps",
        { intent: "pdf", passId: b1.id },
        { name: "b.pdf", type: "application/pdf", bytes: pdf("bo pass") },
        cookie.admin,
        "pdf",
      ),
    );
    mails = mailTo(before, "bo@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("is ready");
  });

  it("won't give one pass to two campers", async () => {
    const pa = await participationOf("bo");
    const a1 = await passId("A-1");
    const res = await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Bo", passId: a1.id, day: "" },
        { cookie: cookie.lead },
      ),
    );
    expect(await res.text()).toContain("just given to someone else");
    expect((await passId("B-1")).holderParticipationId).toBe(pa.id);
  });

  it("releases the pass and flags the decision when a camper's plans change", async () => {
    const pa = await participationOf("amy");
    await w.fetch(post("/rsvp", { intent: "not_going" }, { cookie: cookie.amy }));
    expect((await passId("A-1")).holderParticipationId).toBeNull();
    const [review] = await t.db
      .select()
      .from(sapReview)
      .where(eq(sapReview.participationId, pa.id));
    expect(review).toMatchObject({ status: "approved", flagged: true });
    expect(
      (await w.fetch(get(`/saps/pass/${(await passId("A-1")).id}/pdf`, cookie.amy))).status,
    ).toBe(404);
    const html = await (await w.fetch(get("/saps", cookie.lead))).text();
    expect(html).toContain("Plans changed");
    expect(html).toContain("No longer requesting");
    expect(html).toContain(" · by Lee");
    // The release is recorded, with who caused it, and shows in Amy's History.
    const [logged] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "sap_pass_auto_released"));
    expect(logged).toMatchObject({
      actorPersonId: ids.amy,
      subjectId: ids.amy,
      after: { reason: "rsvp_changed", serials: ["A-1"] },
    });
    const history = await (await w.fetch(get(`/people/${ids.amy}`, cookie.lead))).text();
    expect(history).toContain("SAP pass A-1 released automatically (RSVP changed)");
    expect(history).toContain("RSVP: Not going");
    expect(history).toMatch(
      /SAP approved for Aug \d+, pass A-1[\s\S]{0,200}by [\s\S]{0,20}<a[^>]*>Lee<\/a>/,
    );
    // Undo clears it.
    await w.fetch(
      post(
        "/saps",
        { intent: "undo", participationId: pa.id, name: "Amy" },
        { cookie: cookie.lead },
      ),
    );
    expect(
      await t.db.select().from(sapReview).where(eq(sapReview.participationId, pa.id)),
    ).toHaveLength(0);
  });

  it("denies without an email, releasing any pass", async () => {
    const pa = await participationOf("bo");
    const before = w.emails.length;
    await w.fetch(
      post(
        "/saps",
        { intent: "deny", participationId: pa.id, name: "Bo" },
        { cookie: cookie.lead },
      ),
    );
    expect(mailTo(before, "bo@example.com")).toHaveLength(0);
    expect((await passId("B-1")).holderParticipationId).toBeNull();
    expect(await (await w.fetch(get("/", cookie.bo))).text()).toContain("Not approved");
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["sap_approved", "sap_denied", "sap_decision_undone"]),
    );
  });

  it("won't approve for a day that isn't offered", async () => {
    const pa = await participationOf("bo");
    const res = await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Bo", passId: "", day: "2027-08-30" },
        { cookie: cookie.lead },
      ),
    );
    expect(await res.text()).toContain("isn&#x27;t one of this season&#x27;s SAP days");
  });

  it("won't approve someone who hasn't asked", async () => {
    const pa = await participationOf("cy");
    const res = await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Cy", passId: "", day: "2027-08-24" },
        { cookie: cookie.lead },
      ),
    );
    expect(await res.text()).toContain("haven&#x27;t requested a SAP");
  });
});

describe("deleting passes", () => {
  it("refuses an assigned pass, and deletes an unassigned one with its PDF", async () => {
    const pa = await participationOf("bo");
    const b1 = await passId("B-1");
    await w.fetch(
      post(
        "/saps",
        { intent: "approve", participationId: pa.id, name: "Bo", passId: b1.id, day: "" },
        { cookie: cookie.lead },
      ),
    );
    const refused = await w.fetch(
      post("/admin/saps", { intent: "delete", passId: b1.id }, { cookie: cookie.admin }),
    );
    expect(await refused.text()).toContain("assigned to someone");

    const a1 = await passId("A-1");
    const key = a1.pdfKey as string;
    expect(await w.photo(key)).not.toBeNull();
    await w.fetch(
      post("/admin/saps", { intent: "delete", passId: a1.id }, { cookie: cookie.admin }),
    );
    expect(await passId("A-1")).toBeUndefined();
    expect(await w.photo(key)).toBeNull();
  });
});
