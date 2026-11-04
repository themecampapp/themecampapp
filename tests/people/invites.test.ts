// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { session, user } from "~/db/auth-schema";
import { auditLog, burn, invite, memberRole, participation, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { isAllowlisted } from "~/lib/allowlist.server";
import {
  bulkInviteCandidates,
  changeEmailBeforeSignIn,
  inviteBlocker,
  listPeople,
  sendBulkInvites,
  sendInvite,
  unlinkLogin,
} from "~/lib/invites.server";
import { grantRole } from "~/lib/roles.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { fakeSend, TEST_EMAIL_ENV } from "../helpers/mail";
import { asRoles } from "../helpers/viewer";

let t: TestDb;
const env = {
  ...TEST_EMAIL_ENV,
  MAIL_FROM: "Camp <camp@test>",
  APP_URL: "https://app.test",
  PRODUCT_NAME: "Theme Camp App",
};
let sent: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, invite, participation, audit_log, rate_limit, send_log, session, "user" cascade`;
  sent = [];
  vi.stubGlobal("fetch", vi.fn(fakeSend((m) => sent.push(m.to))));
});
afterEach(() => vi.unstubAllGlobals());

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

async function camper(
  email: string | null,
  opts: { attended?: boolean | null; active?: boolean } = {},
) {
  const [p] = await t.db
    .insert(person)
    .values({ legalName: `Camper ${email}`, email, active: opts.active ?? true })
    .returning();
  if (opts.attended !== undefined) {
    const [season] = await t.db.select().from(burn).where(eq(burn.year, 2026));
    await t.db
      .insert(participation)
      .values({ personId: p.id, burnId: season.id, attended: opts.attended });
  }
  return p;
}

// Wait for actual Postgres contention instead of relying on the scheduling of promises.
async function waitForBlockedQuery(blockerPid: number) {
  const deadline = Date.now() + 5000;
  do {
    const [row] = await t.client`
      select exists (
        select 1 from pg_stat_activity where datname = current_database()
          and ${blockerPid} = any(pg_blocking_pids(pid))
      ) as blocked`;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("Expected the concurrent operation to wait for the person lock");
}

describe("sendInvite", () => {
  it("creates a pending invite, emails a sign-in link with the address pre-filled, and audits", async () => {
    const actor = await lead();
    const p = await camper("new@example.com");
    await sendInvite(t.db, env, actor, p.id);

    expect(sent).toEqual(["new@example.com"]);
    const [inv] = await t.db.select().from(invite).where(eq(invite.personId, p.id));
    expect(inv).toMatchObject({
      status: "pending",
      email: "new@example.com",
      sentByPersonId: actor.personId,
    });
    expect(await isAllowlisted(t.db, "new@example.com")).toBe(true);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "invite_sent")),
    ).toHaveLength(1);
  });

  it("re-sends the same pending invite rather than stacking new ones", async () => {
    const actor = await lead();
    const p = await camper("again@example.com");
    await sendInvite(t.db, env, actor, p.id);
    await sendInvite(t.db, env, actor, p.id);
    expect(await t.db.select().from(invite).where(eq(invite.personId, p.id))).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("refuses the 4th invite to one person in a day", async () => {
    const actor = await lead();
    const p = await camper("spam@example.com");
    for (let i = 0; i < 3; i++) await sendInvite(t.db, env, actor, p.id);
    await expect(sendInvite(t.db, env, actor, p.id)).rejects.toMatchObject({
      data: { reason: "invite_rate_limited" },
    });
  });

  it("won't invite someone with no email, a shared email, or who is deactivated", async () => {
    const noEmail = await camper(null);
    const a = await camper("shared@example.com");
    await camper("shared@example.com");
    const gone = await camper("gone@example.com", { active: false });
    expect(await inviteBlocker(t.db, noEmail.id)).toBe("no_email");
    expect(await inviteBlocker(t.db, a.id)).toBe("shared_email");
    expect(await inviteBlocker(t.db, gone.id)).toBe("inactive");
    await expect(sendInvite(t.db, env, await lead(), a.id)).rejects.toMatchObject({
      data: { reason: "shared_email" },
    });
    expect(sent).toHaveLength(0);
  });
});

describe("bulk invites", () => {
  it("offers only 2026 attendees with a unique email who aren't invited yet", async () => {
    const ok = await camper("ok@example.com", { attended: true });
    await camper("notcame@example.com", { attended: false });
    await camper("unknown@example.com", { attended: null });
    await camper(null, { attended: true });
    await camper("dup@example.com", { attended: true });
    await camper("dup@example.com", { attended: true });
    await camper("inactive@example.com", { attended: true, active: false });
    const invited = await camper("invited@example.com", { attended: true });
    await sendInvite(t.db, env, await lead(), invited.id);

    const ids = (await bulkInviteCandidates(t.db, await lead())).map((c) => c.id);
    expect(ids).toEqual([ok.id]);
  });

  it("sends to each person, marks everyone invited, and skips them on a second run", async () => {
    const actor = await lead();
    const a = await camper("a@example.com", { attended: true });
    const b = await camper("b@example.com", { attended: true });
    const first = await sendBulkInvites(t.db, env, actor, [a.id, b.id]);
    expect(first).toEqual({ sent: 2, failed: [], held: {} });
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
    expect(sent.sort()).toEqual(["a@example.com", "b@example.com"]);

    const second = await sendBulkInvites(t.db, env, actor, [a.id, b.id]);
    expect(second.sent).toBe(0);
    expect(await t.db.select().from(invite)).toHaveLength(2);
  });

  it("keeps invites marked but reports recipients when sending fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    const a = await camper("fail@example.com", { attended: true });
    const result = await sendBulkInvites(t.db, env, await lead(), [a.id]);
    expect(result).toEqual({ sent: 0, failed: ["fail@example.com"], held: {} });
    expect(await t.db.select().from(invite)).toHaveLength(1);
  });
});

describe("email corrections and unlinking", () => {
  it("moves a pending invite to the corrected address before sign-in", async () => {
    const actor = await lead();
    const p = await camper("typo@exmaple.com");
    await sendInvite(t.db, env, actor, p.id);
    await changeEmailBeforeSignIn(t.db, env, actor, p.id, "Fixed@Example.com");

    expect(await isAllowlisted(t.db, "typo@exmaple.com")).toBe(false);
    expect(await isAllowlisted(t.db, "fixed@example.com")).toBe(true);
    expect(sent).toEqual(["typo@exmaple.com", "fixed@example.com"]);
    const statuses = (await t.db.select().from(invite)).map((i) => i.status).sort();
    expect(statuses).toEqual(["pending", "revoked"]);
  });

  it("refuses to change an email to one another active person has", async () => {
    await camper("taken@example.com");
    const p = await camper("mine@example.com");
    await expect(
      changeEmailBeforeSignIn(t.db, env, await lead(), p.id, "Taken@Example.com"),
    ).rejects.toMatchObject({ data: { reason: "email_in_use" } });
  });

  it("refuses to change a linked person's email", async () => {
    await t.db.insert(user).values({ id: "u1", name: "x", email: "linked@example.com" });
    const [p] = await t.db
      .insert(person)
      .values({ legalName: "Linked", email: "linked@example.com", authUserId: "u1" })
      .returning();
    await expect(
      changeEmailBeforeSignIn(t.db, env, await lead(), p.id, "other@example.com"),
    ).rejects.toMatchObject({ data: { reason: "linked_email_locked" } });
  });

  it("unlinking detaches the login and ends its sessions", async () => {
    await t.db.insert(user).values({ id: "u2", name: "x", email: "wrong@example.com" });
    const [p] = await t.db
      .insert(person)
      .values({ legalName: "Wrong", email: "wrong@example.com", authUserId: "u2" })
      .returning();
    await t.db
      .insert(session)
      .values({ id: "s", token: "t", userId: "u2", expiresAt: new Date(Date.now() + 1e7) });

    await unlinkLogin(t.db, await lead(), p.id);
    const [after] = await t.db.select().from(person).where(eq(person.id, p.id));
    expect(after.authUserId).toBeNull();
    expect(await t.db.select().from(session)).toHaveLength(0);
    expect(await isAllowlisted(t.db, "wrong@example.com")).toBe(false);
  });
});

describe("privileged sign-in access", () => {
  it("checks roles after waiting for an in-flight privilege grant", async () => {
    const actor = await lead();
    const p = await camper("grant-in-flight@example.com");
    let correction: Promise<unknown> | undefined;
    await t.db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select().from(person).where(eq(person.id, p.id)).for("update");
      await tx.insert(memberRole).values({ personId: p.id, role: "admin" });
      correction = changeEmailBeforeSignIn(t.db, env, actor, p.id, "attacker@example.com").catch(
        (error) => error,
      );
      await waitForBlockedQuery(pid);
    });
    expect(await correction).toMatchObject({
      data: { reason: "admin_only" },
      init: { status: 403 },
    });
    expect((await t.db.select().from(person).where(eq(person.id, p.id)))[0].email).toBe(p.email);
  });

  it("makes role grants wait for a person whose login is being changed", async () => {
    const actor = { ...(await lead()), ...asRoles(["admin"]) };
    const p = await camper("recovery-in-flight@example.com");
    let grant: Promise<unknown> | undefined;
    await t.db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select().from(person).where(eq(person.id, p.id)).for("update");
      grant = grantRole(t.db, actor, p.id, "admin").catch((error) => error);
      await waitForBlockedQuery(pid);
      expect(await tx.select().from(memberRole).where(eq(memberRole.personId, p.id))).toHaveLength(
        0,
      );
    });
    expect(await grant).toBeUndefined();
    expect(
      (await t.db.select().from(memberRole).where(eq(memberRole.personId, p.id)))[0].role,
    ).toBe("admin");
  });

  it.each(["admin", "treasurer"] as const)(
    "requires matching authority for an unlinked %s, including inactive people",
    async (role) => {
      const actor = await lead();
      const p = await camper("privileged@example.com", { attended: true });
      await t.db.insert(memberRole).values({ personId: p.id, role });
      await t.db.insert(invite).values({ personId: p.id, email: p.email as string });
      // A Lead lacks a Treasurer's dues access (issue #93: "more_access"); only an Admin acts on
      // an Admin.
      const reason = role === "admin" ? "admin_only" : "more_access";
      const denied = { data: { reason }, init: { status: 403 } };
      await expect(sendInvite(t.db, env, actor, p.id)).rejects.toMatchObject(denied);
      await expect(
        changeEmailBeforeSignIn(t.db, env, actor, p.id, "attacker@example.com"),
      ).rejects.toMatchObject(denied);
      await expect(unlinkLogin(t.db, actor, p.id)).rejects.toMatchObject(denied);
      await t.db.update(person).set({ active: false }).where(eq(person.id, p.id));
      await expect(
        changeEmailBeforeSignIn(t.db, env, actor, p.id, "attacker@example.com"),
      ).rejects.toMatchObject(denied);
      expect((await t.db.select().from(person).where(eq(person.id, p.id)))[0].email).toBe(p.email);
      expect((await t.db.select().from(invite).where(eq(invite.personId, p.id)))[0].status).toBe(
        "pending",
      );
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      expect(sent).toEqual([]);
    },
  );

  it("filters privileged bulk candidates and rechecks forged selections on submission", async () => {
    const actor = await lead();
    const ordinary = await camper("ordinary@example.com", { attended: true });
    const admin = await camper("admin@example.com", { attended: true });
    const treasurer = await camper("treasurer@example.com", { attended: true });
    await t.db.insert(memberRole).values([
      { personId: admin.id, role: "admin" },
      { personId: treasurer.id, role: "treasurer" },
    ]);
    expect((await bulkInviteCandidates(t.db, actor)).map((p) => p.id)).toEqual([ordinary.id]);
    const leadTreasurer = { ...actor, ...asRoles(["lead", "treasurer"]) };
    expect((await bulkInviteCandidates(t.db, leadTreasurer)).map((p) => p.id).sort()).toEqual(
      [ordinary.id, treasurer.id].sort(),
    );
    expect(
      (await bulkInviteCandidates(t.db, { ...leadTreasurer, ...asRoles(["admin"]) }))
        .map((p) => p.id)
        .sort(),
    ).toEqual([ordinary.id, admin.id, treasurer.id].sort());
    expect(
      (await sendBulkInvites(t.db, env, actor, [ordinary.id, admin.id, treasurer.id])).sent,
    ).toBe(1);
    expect(sent).toEqual([ordinary.email]);
    expect((await t.db.select().from(invite)).map((i) => i.personId)).toEqual([ordinary.id]);
  });

  it("allows a Lead to recover someone whose privileged roles were revoked", async () => {
    const actor = await lead();
    const p = await camper("revoked@example.com");
    await t.db.insert(memberRole).values({ personId: p.id, role: "admin", revokedAt: new Date() });
    await changeEmailBeforeSignIn(t.db, env, actor, p.id, "correct@example.com");
    await sendInvite(t.db, env, actor, p.id);
    expect(sent).toEqual(["correct@example.com"]);
  });

  it.each(["admin", "treasurer"] as const)("allows authorized recovery of a %s", async (role) => {
    const actor = {
      ...(await lead()),
      ...asRoles(role === "admin" ? ["admin"] : ["lead", "treasurer"]),
    };
    await t.db
      .insert(user)
      .values({ id: "privileged-user", name: "Privileged", email: "old@example.com" });
    const [p] = await t.db
      .insert(person)
      .values({
        legalName: "Privileged",
        email: "old@example.com",
        authUserId: "privileged-user",
      })
      .returning();
    await t.db.insert(memberRole).values({ personId: p.id, role });
    await t.db
      .insert(invite)
      .values({ personId: p.id, email: "old@example.com", status: "linked" });
    await t.db.insert(session).values({
      id: "privileged-session",
      token: "privileged-token",
      userId: "privileged-user",
      expiresAt: new Date(Date.now() + 1e7),
    });
    await unlinkLogin(t.db, actor, p.id);
    await changeEmailBeforeSignIn(t.db, env, actor, p.id, "correct@example.com");
    await sendInvite(t.db, env, actor, p.id);
    expect(sent).toEqual(["correct@example.com"]);
    expect(await t.db.select().from(session)).toHaveLength(0);
    expect(
      (await t.db.select().from(memberRole).where(eq(memberRole.personId, p.id)))[0].revokedAt,
    ).toBeNull();
    expect(await isAllowlisted(t.db, "old@example.com")).toBe(false);
    expect(await isAllowlisted(t.db, "correct@example.com")).toBe(true);
  });
});

describe("listPeople", () => {
  it("derives invite status in order: RSVP'd > signed in > invited > not invited", async () => {
    const actor = await lead();
    const notInvited = await camper("n@example.com");
    const invited = await camper("i@example.com");
    await sendInvite(t.db, env, actor, invited.id);
    await t.db.insert(user).values({ id: "u3", name: "x", email: "s@example.com" });
    const [signedIn] = await t.db
      .insert(person)
      .values({ legalName: "Signed", email: "s@example.com", authUserId: "u3" })
      .returning();
    const rsvpd = await camper("r@example.com");
    const [y27] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await t.db.insert(participation).values({
      personId: rsvpd.id,
      burnId: y27.id,
      intent: "going",
      updatedByPersonId: actor.personId,
    });

    const status = Object.fromEntries(
      (await listPeople(t.db, { contact: true, year: 2027 })).map((p) => [p.id, p.status]),
    );
    expect(status[notInvited.id]).toBe("not_invited");
    expect(status[invited.id]).toBe("invited");
    expect(status[signedIn.id]).toBe("signed_in");
    expect(status[rsvpd.id]).toBe("rsvpd_by_lead");
  });

  it("marks everyone who has signed in, even after they RSVP", async () => {
    await t.db.insert(user).values({ id: "u4", name: "x", email: "sr@example.com" });
    const [both] = await t.db
      .insert(person)
      .values({ legalName: "Both", email: "sr@example.com", authUserId: "u4" })
      .returning();
    const [y27] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    await t.db.insert(participation).values({
      personId: both.id,
      burnId: y27.id,
      intent: "going",
      updatedByPersonId: both.id,
    });
    const row = (await listPeople(t.db, { contact: true, year: 2027 })).find(
      (p) => p.id === both.id,
    );
    expect(row).toMatchObject({ status: "rsvpd", signedIn: true });
  });

  it("lists each person's past camp years and filters by a camp year", async () => {
    const both = await camper("both@example.com", { attended: true });
    const [y24] = await t.db.select().from(burn).where(eq(burn.year, 2024));
    await t.db.insert(participation).values({ personId: both.id, burnId: y24.id, attended: true });
    const didnt = await camper("no@example.com", { attended: false });
    const none = await camper("none@example.com");

    const years = Object.fromEntries(
      (await listPeople(t.db, { contact: true, year: 2027 })).map((p) => [p.id, p.campYears]),
    );
    expect(years[both.id]).toEqual([2024, 2026]);
    expect(years[didnt.id]).toEqual([]);
    expect(years[none.id]).toEqual([]);

    const in2024 = await listPeople(t.db, { contact: true, year: 2027, campYear: 2024 });
    expect(in2024.map((p) => p.id)).toEqual([both.id]);
    const in2026 = await listPeople(t.db, { contact: true, year: 2027, campYear: 2026 });
    expect(in2026.map((p) => p.id)).toEqual([both.id]);
  });
});
