// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { session, user } from "~/db/auth-schema";
import { auditLog, memberRole, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { deactivatePerson, grantRole, revokeRole } from "~/lib/roles.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, member_role, audit_log, session, "user" cascade`;
});

async function makePerson(name: string, roles: Array<"lead" | "treasurer" | "admin"> = []) {
  const [p] = await t.db.insert(person).values({ legalName: name }).returning();
  for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
  const viewer: Viewer = {
    personId: p.id,
    authUserId: `auth-${p.id}`,
    legalName: name,
    playaName: null,
    ...asRoles(roles),
  };
  return viewer;
}

async function activeRoles(personId: string) {
  const rows = await t.db
    .select({ role: memberRole.role })
    .from(memberRole)
    .where(and(eq(memberRole.personId, personId), isNull(memberRole.revokedAt)));
  return rows.map((r) => r.role).sort();
}

const status = (e: unknown) => (e as { init?: { status?: number } })?.init?.status;

describe("role management guards", () => {
  it("lets an Admin grant Lead, and audits it", async () => {
    const admin = await makePerson("Admin", ["admin"]);
    const member = await makePerson("Member");
    await grantRole(t.db, admin, member.personId, "lead");
    expect(await activeRoles(member.personId)).toEqual(["lead"]);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "role_granted")),
    ).toHaveLength(1);
  });

  // Issue #93 (R6): only Admins give or take away roles, Lead and Treasurer included.
  it("refuses a Lead or a Treasurer giving any role", async () => {
    const lead = await makePerson("Lead", ["lead"]);
    const treasurer = await makePerson("Treasurer", ["treasurer"]);
    const both = await makePerson("Both", ["lead", "treasurer"]);
    const member = await makePerson("Member");
    for (const [actor, role] of [
      [lead, "lead"],
      [treasurer, "treasurer"],
      [both, "treasurer"],
    ] as const) {
      const err = await grantRole(t.db, actor, member.personId, role).catch((e) => e);
      expect(status(err)).toBe(403);
    }
    expect(await activeRoles(member.personId)).toEqual([]);
    expect(status(await revokeRole(t.db, lead, both.personId, "lead").catch((e) => e))).toBe(403);
  });

  // Issue #93 (R11 as amended): Admin is the only role with a last holder.
  it("lets the last Lead or Treasurer lose the role, but not the last Admin", async () => {
    const admin = await makePerson("Admin", ["admin"]);
    const both = await makePerson("Only", ["lead", "treasurer"]);
    await revokeRole(t.db, admin, both.personId, "lead");
    await revokeRole(t.db, admin, both.personId, "treasurer");
    expect(await activeRoles(both.personId)).toEqual([]);
    expect(status(await revokeRole(t.db, admin, admin.personId, "admin").catch((e) => e))).toBe(
      409,
    );
    expect(await activeRoles(admin.personId)).toEqual(["admin"]);
  });

  it("leaves at least one Admin when two Admins revoke each other concurrently", async () => {
    const a = await makePerson("A", ["admin"]);
    const b = await makePerson("B", ["admin"]);
    const results = await Promise.allSettled([
      revokeRole(t.db, a, b.personId, "admin"),
      revokeRole(t.db, b, a.personId, "admin"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const remaining = [...(await activeRoles(a.personId)), ...(await activeRoles(b.personId))];
    expect(remaining).toEqual(["admin"]);
  });

  it("refuses to deactivate the last Admin, and lets the last Lead go", async () => {
    const admin = await makePerson("Admin", ["admin"]);
    expect(status(await deactivatePerson(t.db, admin, admin.personId).catch((e) => e))).toBe(409);
    const lead = await makePerson("Lead", ["lead"]);
    await deactivatePerson(t.db, admin, lead.personId);
    expect((await t.db.select().from(person).where(eq(person.id, lead.personId)))[0].active).toBe(
      false,
    );
  });

  it("gives a granted Lead twice only one active row", async () => {
    const admin = await makePerson("Admin", ["admin"]);
    const member = await makePerson("Member");
    await grantRole(t.db, admin, member.personId, "lead");
    await grantRole(t.db, admin, member.personId, "lead");
    expect(await activeRoles(member.personId)).toEqual(["lead"]);
  });

  it("requires a Treasurer to deactivate a Treasurer", async () => {
    const lead = await makePerson("Lead", ["lead"]);
    await makePerson("T1", ["treasurer"]);
    const t2 = await makePerson("T2", ["treasurer"]);
    expect(status(await deactivatePerson(t.db, lead, t2.personId).catch((e) => e))).toBe(403);
  });

  it("deactivation ends existing sessions and is audited", async () => {
    const lead = await makePerson("Lead", ["lead"]);
    await makePerson("Admin", ["admin"]);
    await t.db.insert(user).values({ id: "u-member", name: "m", email: "m@example.com" });
    const [m] = await t.db
      .insert(person)
      .values({ legalName: "Member", authUserId: "u-member" })
      .returning();
    await t.db.insert(session).values({
      id: "s1",
      token: "tok",
      userId: "u-member",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await deactivatePerson(t.db, lead, m.id);
    expect((await t.db.select().from(person).where(eq(person.id, m.id)))[0].active).toBe(false);
    expect(await t.db.select().from(session)).toHaveLength(0);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "person_deactivated")),
    ).toHaveLength(1);
  });

  it("refuses a Member performing Lead actions", async () => {
    const member = await makePerson("Member");
    const other = await makePerson("Other");
    expect(status(await grantRole(t.db, member, other.personId, "lead").catch((e) => e))).toBe(403);
    expect(status(await deactivatePerson(t.db, member, other.personId).catch((e) => e))).toBe(403);
  });
});
