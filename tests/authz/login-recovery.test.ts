// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session } from "~/db/auth-schema";
import { auditLog, invite, memberRole, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let leadCookie: string;
let leadTreasurerCookie: string;
let adminCookie: string;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  for (const [email, roles] of [
    ["lead@example.com", ["lead"]],
    ["lead-treasurer@example.com", ["lead", "treasurer"]],
    ["admin@example.com", ["admin"]],
  ] as const) {
    const p = await invitePerson(t, email);
    await t.db.insert(memberRole).values(roles.map((role) => ({ personId: p.id, role })));
    const cookie = await signIn(w, email);
    await w.fetch(get("/", cookie));
    if (email === "lead@example.com") leadCookie = cookie;
    else if (email === "lead-treasurer@example.com") leadTreasurerCookie = cookie;
    else adminCookie = cookie;
  }
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("privileged login recovery through the real Worker", () => {
  it.each([
    { role: "admin", caller: "lead" },
    { role: "admin", caller: "lead-treasurer" },
    { role: "treasurer", caller: "lead" },
  ] as const)(
    "blocks the $caller takeover sequence against a signed-in $role",
    async ({ role, caller }) => {
      const email = `${role}-${caller}@example.com`;
      const target = await invitePerson(t, email);
      await t.db.insert(memberRole).values({ personId: target.id, role });
      const targetCookie = await signIn(w, email);
      await w.fetch(get("/", targetCookie));
      const [before] = await t.db.select().from(person).where(eq(person.id, target.id));
      const sessions = await t.db
        .select()
        .from(session)
        .where(eq(session.userId, before.authUserId as string));
      expect(sessions.length).toBeGreaterThan(0);
      const emailsBefore = w.emails.length;
      const cookie = caller === "lead" ? leadCookie : leadTreasurerCookie;
      const message = role === "admin" ? "Only an Admin" : "This person can do things you can";

      for (const fields of [
        { intent: "unlink" },
        { intent: "update", legalName: before.legalName, email: "attacker@example.com" },
        { intent: "invite" },
      ] as Record<string, string>[]) {
        const response = await w.fetch(post(`/people/${target.id}`, fields, { cookie }));
        expect(response.status).toBe(200); // Existing route convention: refusal shown on the form.
        expect(await response.text()).toContain(message);
      }
      const [after] = await t.db.select().from(person).where(eq(person.id, target.id));
      expect(after).toMatchObject({ email, authUserId: before.authUserId, active: true });
      expect(
        await t.db
          .select()
          .from(session)
          .where(eq(session.userId, before.authUserId as string)),
      ).toEqual(sessions);
      expect(
        (await t.db.select().from(invite).where(eq(invite.personId, target.id)))[0].status,
      ).toBe("linked");
      expect(
        await t.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.subjectId, target.id), eq(auditLog.action, "login_unlinked"))),
      ).toHaveLength(0);
      expect(w.emails).toHaveLength(emailsBefore);
      expect((await w.fetch(get("/", targetCookie))).status).toBe(200);

      const page = await (await w.fetch(get(`/people/${target.id}`, cookie))).text();
      expect(page).toContain(
        role === "admin" ? "Only an Admin can manage" : "This person can do things you can",
      );
      expect(page).not.toContain("Unlink login");
    },
  );

  it.each(["admin", "treasurer"] as const)(
    "protects a pending %s invite from email substitution and resend",
    async (role) => {
      const target = await invitePerson(t, `pending-${role}@example.com`);
      await t.db.insert(memberRole).values({ personId: target.id, role });
      const emailsBefore = w.emails.length;
      for (const fields of [
        { intent: "update", legalName: target.legalName, email: "attacker@example.com" },
        { intent: "invite" },
      ] as Record<string, string>[]) {
        const response = await w.fetch(
          post(`/people/${target.id}`, fields, { cookie: leadCookie }),
        );
        expect(await response.text()).toContain(
          role === "admin" ? "Only an Admin" : "This person can do things you can",
        );
      }
      expect((await t.db.select().from(person).where(eq(person.id, target.id)))[0].email).toBe(
        target.email,
      );
      expect(
        (await t.db.select().from(invite).where(eq(invite.personId, target.id)))[0],
      ).toMatchObject({
        email: target.email,
        status: "pending",
      });
      expect(w.emails).toHaveLength(emailsBefore);
      const page = await (await w.fetch(get(`/people/${target.id}`, leadCookie))).text();
      expect(page).not.toContain("Resend invite");
      expect(page.match(/<input\b[^>]*\bname="email"[^>]*>/)?.[0]).toContain("disabled");
    },
  );

  it("lets an Admin complete recovery, retaining the target's Admin access", async () => {
    const target = await invitePerson(t, "recover-admin@example.com");
    await t.db.insert(memberRole).values({ personId: target.id, role: "admin" });
    const oldCookie = await signIn(w, "recover-admin@example.com");
    await w.fetch(get("/", oldCookie));
    for (const fields of [
      { intent: "unlink" },
      { intent: "update", legalName: target.legalName, email: "recovered-admin@example.com" },
      { intent: "invite" },
    ] as Record<string, string>[]) {
      const response = await w.fetch(post(`/people/${target.id}`, fields, { cookie: adminCookie }));
      expect(response.status).toBe(302);
      await response.text();
    }
    expect((await w.fetch(get("/", oldCookie))).status).toBe(302);
    const recoveredCookie = await signIn(w, "recovered-admin@example.com");
    await w.fetch(get("/", recoveredCookie));
    const [after] = await t.db.select().from(person).where(eq(person.id, target.id));
    expect(after.authUserId).toBeTruthy();
    expect(after.email).toBe("recovered-admin@example.com");
    expect((await w.fetch(get("/admin", recoveredCookie))).status).toBe(200);
  });
});
