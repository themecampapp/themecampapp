// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "~/db/auth-schema";
import { inquiry, inquiryNote, invite, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { listActivity } from "~/lib/activity.server";
import {
  closeAsExistingCamper,
  closeMatchedImportedInquiries,
  inviteFromInquiry,
  type JoinInput,
  matchedImportedInquiries,
  parseJoinForm,
  submitJoin,
  updateInquiry,
} from "~/lib/data/inquiries.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { fakeSend, htmlToText, TEST_EMAIL_ENV } from "../helpers/mail";
import { asRoles } from "../helpers/viewer";

let t: TestDb;
const NOTIFY = ["lead1@example.com", "lead2@example.com"];
const env = {
  ...TEST_EMAIL_ENV,
  MAIL_FROM: "Camp <camp@test>",
  APP_URL: "https://app.test",
  PRODUCT_NAME: "Theme Camp App",
};
let sent: Array<{ to: string; subject: string; text: string }> = [];

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, inquiry, inquiry_note, invite, send_log, rate_limit, audit_log, "user" cascade`;
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(fakeSend((b) => sent.push({ to: b.to, subject: b.subject, text: htmlToText(b.body) }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

const input = (overrides: Partial<JoinInput> = {}): JoinInput => ({
  name: "Nova Newcomer",
  playaName: null,
  email: "nova@example.com",
  phone: null,
  heardFrom: "a friend",
  note: "SECRET-NOTE-TEXT",
  ...overrides,
});

async function lead(): Promise<Viewer> {
  const [p] = await t.db.insert(person).values({ legalName: "Lead" }).returning();
  return {
    personId: p.id,
    authUserId: "x",
    legalName: "Lead",
    playaName: null,
    ...asRoles(["lead"]),
  };
}

describe("parseJoinForm", () => {
  it("requires a name and a valid email, and normalizes the email", () => {
    const f = new FormData();
    f.set("name", "  Nova  ");
    f.set("email", " Nova@Example.COM ");
    expect(parseJoinForm(f)).toMatchObject({ input: { name: "Nova", email: "nova@example.com" } });
    f.set("email", "nope");
    expect(parseJoinForm(f)).toEqual({ error: "Please enter a valid email address." });
  });
});

describe("submitJoin", () => {
  it("creates a new inquiry, confirms to the submitter and notifies each lead with fixed text", async () => {
    const { isNew, inquiryId } = await submitJoin(t.db, env, input(), NOTIFY);
    expect(isNew).toBe(true);
    const [row] = await t.db.select().from(inquiry).where(eq(inquiry.id, inquiryId));
    expect(row).toMatchObject({ status: "new", source: "join_form", note: "SECRET-NOTE-TEXT" });

    expect(sent.map((m) => m.to).sort()).toEqual([
      "lead1@example.com",
      "lead2@example.com",
      "nova@example.com",
    ]);
    for (const m of sent) {
      expect(m.text).not.toContain("SECRET-NOTE-TEXT");
      expect(m.text).not.toContain("Nova");
    }
    expect(sent.find((m) => m.to === "lead1@example.com")?.text).toContain(
      `/inquiries/${inquiryId}`,
    );
  });

  it("adds a repeat submission to the open inquiry and confirms at most once a day", async () => {
    await submitJoin(t.db, env, input(), NOTIFY);
    const again = await submitJoin(t.db, env, input({ note: "second try" }), NOTIFY);
    expect(again.isNew).toBe(false);
    expect(await t.db.select().from(inquiry)).toHaveLength(1);
    const notes = await t.db.select().from(inquiryNote);
    expect(notes[0].body).toContain("second try");
    expect(sent.filter((m) => m.to === "nova@example.com")).toHaveLength(1);
    expect(sent.filter((m) => m.to === "lead1@example.com")).toHaveLength(1);
  });

  it("opens a fresh inquiry after a declined one, keeping the person link", async () => {
    const actor = await lead();
    const { inquiryId } = await submitJoin(t.db, env, input(), NOTIFY);
    await inviteFromInquiry(t.db, env, actor, inquiryId, { create: true });
    const [first] = await t.db.select().from(inquiry).where(eq(inquiry.id, inquiryId));

    const second = await submitJoin(t.db, env, input(), NOTIFY);
    expect(second.isNew).toBe(true);
    const [row] = await t.db.select().from(inquiry).where(eq(inquiry.id, second.inquiryId));
    expect(row.personId).toBe(first.personId);
  });
});

describe("inviteFromInquiry", () => {
  it("creates a member from a new inquiry, invites them, and closes the inquiry", async () => {
    const actor = await lead();
    const { inquiryId } = await submitJoin(
      t.db,
      env,
      input({ playaName: "Star", phone: "555" }),
      NOTIFY,
    );
    sent = [];
    const { personId, alreadyMember } = await inviteFromInquiry(t.db, env, actor, inquiryId, {
      create: true,
    });

    expect(alreadyMember).toBe(false);
    const [p] = await t.db.select().from(person).where(eq(person.id, personId));
    expect(p).toMatchObject({
      legalName: "Nova Newcomer",
      playaName: "Star",
      email: "nova@example.com",
      phone: "555",
    });
    expect((await t.db.select().from(invite).where(eq(invite.personId, personId)))[0].status).toBe(
      "pending",
    );
    expect(sent.map((m) => m.to)).toEqual(["nova@example.com"]);
    expect((await t.db.select().from(inquiry).where(eq(inquiry.id, inquiryId)))[0]).toMatchObject({
      status: "invited",
      personId,
    });
  });

  it("won't create a second person when an active one has the inquiry's email", async () => {
    const actor = await lead();
    await t.db.insert(person).values({ legalName: "Nova", email: "nova@example.com" });
    const { inquiryId } = await submitJoin(t.db, env, input(), NOTIFY);
    await expect(
      inviteFromInquiry(t.db, env, actor, inquiryId, { create: true }),
    ).rejects.toMatchObject({ data: { reason: "email_in_use" } });
    expect(
      await t.db.select().from(person).where(eq(person.email, "nova@example.com")),
    ).toHaveLength(1);
  });

  it("links to an existing active member without sending another invite", async () => {
    const actor = await lead();
    await t.db.insert(user).values({ id: "u1", name: "x", email: "nova@example.com" });
    const [member] = await t.db
      .insert(person)
      .values({ legalName: "Nova", email: "nova@example.com", authUserId: "u1" })
      .returning();
    const { inquiryId } = await submitJoin(t.db, env, input(), NOTIFY);
    sent = [];
    const result = await inviteFromInquiry(t.db, env, actor, inquiryId, { personId: member.id });
    expect(result).toEqual({ personId: member.id, alreadyMember: true });
    expect(sent).toHaveLength(0);
  });

  it("records status and assignment changes, with who made them, for the inquiry's History", async () => {
    const actor = await lead();
    await t.db.update(person).set({ playaName: "Lee" }).where(eq(person.id, actor.personId));
    const { inquiryId } = await submitJoin(t.db, env, input(), NOTIFY);
    await updateInquiry(t.db, actor, inquiryId, { status: "contacted" });
    await updateInquiry(t.db, actor, inquiryId, { assignedToPersonId: actor.personId });
    const { rows } = await listActivity(t.db, { inquiryId, limit: 10 });
    expect(rows.map((r) => [r.text, r.actor?.name])).toEqual([
      ["Assigned to Lee", "Lee"],
      ["Status: New → Contacted", "Lee"],
    ]);
  });

  it("won't let the status dropdown mark someone invited without inviting them", async () => {
    const { inquiryId } = await submitJoin(t.db, env, input(), NOTIFY);
    await expect(
      updateInquiry(t.db, await lead(), inquiryId, { status: "invited" }),
    ).rejects.toMatchObject({
      data: { reason: "use_invite" },
    });
  });
});

describe("closing inquiries from existing campers", () => {
  async function imported(
    name: string,
    email: string | null,
    personId: string | null = null,
    status: "new" | "declined" = "new",
  ) {
    const [row] = await t.db
      .insert(inquiry)
      .values({ name, email, personId, status, source: "import" })
      .returning();
    return row;
  }

  it("links and closes one inquiry without sending any email", async () => {
    const actor = await lead();
    const [p] = await t.db
      .insert(person)
      .values({ legalName: "Phoebe", email: "phoebe@example.com" })
      .returning();
    const inq = await imported("Phoebe", "phoebe@example.com", p.id);

    await closeAsExistingCamper(t.db, actor, inq.id, p.id);

    expect(sent).toHaveLength(0);
    expect(await t.db.select().from(invite)).toHaveLength(0);
    const [row] = await t.db.select().from(inquiry).where(eq(inquiry.id, inq.id));
    expect(row).toMatchObject({ status: "invited", personId: p.id });
    const [note] = await t.db.select().from(inquiryNote).where(eq(inquiryNote.inquiryId, inq.id));
    expect(note.body).toContain("No email was sent");
  });

  it("bulk-closes only open imported inquiries that match exactly one person", async () => {
    const actor = await lead();
    const [a] = await t.db
      .insert(person)
      .values({ legalName: "Linked", email: "linked@example.com" })
      .returning();
    await t.db.insert(person).values({ legalName: "ByEmail", email: "byemail@example.com" });
    await t.db.insert(person).values([
      { legalName: "Twin 1", email: "twin@example.com" },
      { legalName: "Twin 2", email: "twin@example.com" },
    ]);
    const linked = await imported("Linked", "linked@example.com", a.id);
    const byEmail = await imported("ByEmail", "byemail@example.com");
    const ambiguous = await imported("Twin", "twin@example.com");
    const stranger = await imported("Stranger", "stranger@example.com");
    const closed = await imported("Old", "linked@example.com", a.id, "declined");
    // A join-form inquiry is never swept up, even when its email matches a person.
    await t.db.insert(person).values({ legalName: "Former", email: "formperson@example.com" });
    const { inquiryId: fromForm } = await submitJoin(
      t.db,
      env,
      input({ email: "formperson@example.com" }),
      NOTIFY,
    );
    sent = [];

    expect((await matchedImportedInquiries(t.db)).map((m) => m.id).sort()).toEqual(
      [linked.id, byEmail.id].sort(),
    );
    expect(await closeMatchedImportedInquiries(t.db, actor)).toBe(2);
    expect(sent).toHaveLength(0);

    const status = Object.fromEntries(
      (await t.db.select().from(inquiry)).map((r) => [r.id, r.status]),
    );
    expect(status[linked.id]).toBe("invited");
    expect(status[byEmail.id]).toBe("invited");
    expect(status[ambiguous.id]).toBe("new");
    expect(status[stranger.id]).toBe("new");
    expect(status[closed.id]).toBe("declined");
    expect(status[fromForm]).toBe("new");
    expect(await matchedImportedInquiries(t.db)).toHaveLength(0);
  });
});
