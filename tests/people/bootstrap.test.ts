// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, invite, memberRole } from "~/db/schema";
import { bootstrapFirstLead } from "~/lib/bootstrap.server";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

describe("bootstrapFirstLead", () => {
  it("creates the first Lead + Treasurer with a pending invite, then refuses to run again", async () => {
    const p = await bootstrapFirstLead(t.db, {
      legalName: "First Lead",
      email: " Lead@Example.com ",
    });

    expect(p.email).toBe("lead@example.com");
    const invites = await t.db.select().from(invite);
    expect(invites).toMatchObject([
      { personId: p.id, email: "lead@example.com", status: "pending" },
    ]);
    const roles = (await t.db.select().from(memberRole)).map((r) => r.role).sort();
    expect(roles).toEqual(["lead", "treasurer"]);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);

    await expect(
      bootstrapFirstLead(t.db, { legalName: "Second", email: "second@example.com" }),
    ).rejects.toThrow(/already exists/);
  });
});
