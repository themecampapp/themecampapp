// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inquiry, memberRole, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { peopleCsv } from "~/lib/data/export.server";
import { getInquiry, inviteFromInquiry } from "~/lib/data/inquiries.server";
import { BUILTIN_DEFAULTS } from "~/lib/permissions";
import { createTestDb, type TestDb } from "../helpers/db";
import { sendResponse, TEST_EMAIL_ENV } from "../helpers/mail";
import { asRoles } from "../helpers/viewer";

// Issue #93: data the area levels decide, beyond which pages open.

let t: TestDb;
const env = {
  ...TEST_EMAIL_ENV,
  MAIL_FROM: "Camp <camp@test>",
  APP_URL: "https://app.test",
  PRODUCT_NAME: "Theme Camp App",
};

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, inquiry, inquiry_note, invite, send_log, rate_limit, audit_log cascade`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sendResponse("email_1")),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function actor(access: Viewer["access"]): Promise<Viewer> {
  const [p] = await t.db.insert(person).values({ legalName: "Actor" }).returning();
  return {
    personId: p.id,
    authUserId: "x",
    legalName: "Actor",
    playaName: null,
    access,
    roles: [],
  };
}

describe("the people export without Private details & notes", () => {
  it("leaves out unshared contact details, mailing addresses and notes", async () => {
    await t.db.insert(person).values([
      {
        legalName: "Private Pat",
        email: "pat@example.com",
        phone: "5550001111",
        homeLocation: "Oakland",
        note2026: "PRIVATE-NOTE",
        mailingAddress: {
          line1: "1 Secret St",
          line2: null,
          city: "Oakland",
          region: null,
          postalCode: null,
          country: "United States",
        },
      },
      {
        legalName: "Sharing Sam",
        email: "sam@example.com",
        phone: "5550002222",
        directoryChoiceSeenAt: new Date(),
      },
    ]);
    const without = await actor({ ...BUILTIN_DEFAULTS.lead, private: "none" });
    const csv = await peopleCsv(t.db, without);
    expect(csv).not.toContain("pat@example.com");
    expect(csv).not.toContain("5550001111");
    expect(csv).not.toContain("Oakland");
    expect(csv).not.toContain("PRIVATE-NOTE");
    expect(csv).not.toContain("1 Secret St");
    expect(csv.split("\n")[0]).not.toContain("2026 note");
    expect(csv.split("\n")[0]).not.toContain("Mailing");
    // Someone who shares their contact details in the directory is in it either way.
    expect(csv).toContain("sam@example.com");
    expect(csv).toContain("5550002222");

    const lead = await actor(BUILTIN_DEFAULTS.lead);
    const full = await peopleCsv(t.db, lead);
    expect(full).toContain("pat@example.com");
    expect(full).toContain("PRIVATE-NOTE");
  });
});

describe("inquiries", () => {
  it("can be assigned to whoever can manage them, and to no one else", async () => {
    const make = async (name: string, roles: Array<"lead" | "treasurer" | "admin">) => {
      const [p] = await t.db.insert(person).values({ legalName: name }).returning();
      for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
      return p;
    };
    await make("Lee Lead", ["lead"]);
    await make("Tia Treasurer", ["treasurer"]);
    await make("Ada Admin", ["admin"]);
    const gone = await make("Gone Lead", ["lead"]);
    await t.db.update(person).set({ active: false }).where(eq(person.id, gone.id));
    await make("Mo Member", []);
    const [{ id }] = await t.db
      .insert(inquiry)
      .values({ name: "Curious", email: "curious@example.com", source: "join_form" })
      .returning({ id: inquiry.id });
    const found = await getInquiry(t.db, id);
    expect(found?.leads.map((l) => l.name)).toEqual(["Ada Admin", "Lee Lead"]);
  });

  it("need People: manage to invite someone from one", async () => {
    const [{ id }] = await t.db
      .insert(inquiry)
      .values({ name: "Curious", email: "curious@example.com", source: "join_form" })
      .returning({ id: inquiry.id });
    const intakeOnly = await actor({ ...asRoles([]).access, inquiries: "manage" });
    await expect(
      inviteFromInquiry(t.db, env, intakeOnly, id, { create: true }),
    ).rejects.toMatchObject({ data: { reason: "forbidden" }, init: { status: 403 } });
    expect(await t.db.select().from(person).where(eq(person.email, "curious@example.com"))).toEqual(
      [],
    );
  });
});
