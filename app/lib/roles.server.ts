// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNull, sql } from "drizzle-orm";
import { data } from "react-router";
import { session } from "~/db/auth-schema";
import { campRole, memberRole, person } from "~/db/schema";
import { assertAccess, type Viewer } from "./access.server";
import { audit } from "./audit.server";
import { getCampSettings } from "./data/camp-settings.server";
import { releaseForPerson } from "./data/sap-cascade.server";
import type { Db } from "./db.server";
import { loginManagementReason } from "./login-management";
import { personAccess } from "./role-access.server";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Role = "lead" | "treasurer" | "admin";
// A role to give or take away: a built-in one, or one of the camp's custom roles (issue #93).
export type RoleRef = Role | { customRoleId: string };

const forbidden = (reason: string) => data({ reason }, { status: 403 });
const conflict = (reason: string) => data({ reason }, { status: 409 });

// Locks every active holder of `role` and returns how many active people hold it.
// Locking first means two concurrent revocations can't both see "one other holder left".
export async function lockActiveHolders(tx: Tx, role: Role) {
  const rows = await tx.execute<{ person_id: string }>(sql`
    select mr.person_id from member_role mr
    join person p on p.id = mr.person_id
    where mr.role = ${role} and mr.revoked_at is null and p.active
    for update of mr
  `);
  return rows.map((r) => r.person_id);
}

// Issue #93 (R6): only Admins give or take away roles, built-in or custom.
function assertCanAssign(actor: Viewer) {
  if (!actor.isAdmin) throw forbidden("admin_only");
}

// Someone who isn't an Admin may act on a person (their sign-in, deactivating or reactivating
// them) only with People: manage, and only on a person who can do nothing they can't in the
// areas the camp uses (login-management.ts). Retained roles count for inactive and
// not-yet-linked people too. Read in the caller's transaction, after locking the person row.
async function actingReason(tx: Tx, actor: Viewer, personId: string) {
  const { features } = await getCampSettings(tx);
  return loginManagementReason(actor, await personAccess(tx, personId), features);
}

// Call after locking the person row. grantRole takes the same lock, so a concurrent
// privilege grant can't slip between this check and a change to their sign-in access.
export async function assertCanManagePersonLogin(tx: Tx, actor: Viewer, personId: string) {
  const reason = await actingReason(tx, actor, personId);
  if (reason) throw forbidden(reason);
}

export async function lockPersonForLoginManagement(tx: Tx, actor: Viewer, personId: string) {
  const [target] = await tx.select().from(person).where(eq(person.id, personId)).for("update");
  if (!target) throw data({ reason: "not_found" }, { status: 404 });
  await assertCanManagePersonLogin(tx, actor, personId);
  return target;
}

// A custom role that can still be given, locked so it can't be archived meanwhile.
async function lockCustomRole(tx: Tx, id: string) {
  const [row] = await tx.select().from(campRole).where(eq(campRole.id, id)).for("update");
  if (!row || row.builtin) throw data({ reason: "not_found" }, { status: 404 });
  if (row.archivedAt) throw conflict("role_archived");
  return row;
}

const roleLabel = (role: RoleRef, name?: string | null) =>
  typeof role === "string" ? { role } : { role: "custom", customRoleId: role.customRoleId, name };

export async function grantRole(db: Db, actor: Viewer, personId: string, role: RoleRef) {
  assertCanAssign(actor);
  await db.transaction(async (tx) => {
    const custom = typeof role === "string" ? null : await lockCustomRole(tx, role.customRoleId);
    if (typeof role === "string") await lockActiveHolders(tx, role);
    const [target] = await tx.select().from(person).where(eq(person.id, personId)).for("update");
    if (!target?.active) throw conflict("inactive_person");
    const inserted = await tx
      .insert(memberRole)
      .values({
        personId,
        role: custom ? "custom" : (role as Role),
        customRoleId: custom?.id ?? null,
        grantedByPersonId: actor.personId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length) {
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "role_granted",
        subjectType: "person",
        subjectId: personId,
        after: roleLabel(role, custom?.name),
      });
    }
  });
}

// Takes `role` away from someone. Only the last active Admin can't lose it (issue #93, R11 as
// amended): an Admin can always do everything, so no other role needs a last holder.
export async function revokeRole(db: Db, actor: Viewer, personId: string, role: RoleRef) {
  assertCanAssign(actor);
  await db.transaction(async (tx) => {
    if (role === "admin") {
      const admins = await lockActiveHolders(tx, "admin");
      if (admins.includes(personId) && admins.length <= 1) throw conflict("last_admin");
    }
    const which =
      typeof role === "string"
        ? eq(memberRole.role, role)
        : and(eq(memberRole.role, "custom"), eq(memberRole.customRoleId, role.customRoleId));
    const revoked = await tx
      .update(memberRole)
      .set({ revokedAt: new Date(), revokedByPersonId: actor.personId })
      .where(and(eq(memberRole.personId, personId), which, isNull(memberRole.revokedAt)))
      .returning({ id: memberRole.id });
    if (!revoked.length) return;
    const name =
      typeof role === "string"
        ? null
        : ((await tx.select().from(campRole).where(eq(campRole.id, role.customRoleId)))[0]?.name ??
          null);
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "role_revoked",
      subjectType: "person",
      subjectId: personId,
      before: roleLabel(role, name),
    });
  });
}

// Sessions live in Better Auth's platform-wide table (no row-level security), so the camp
// filter is explicit.
export async function endCampSessions(db: Db | Tx, authUserId: string) {
  await db
    .delete(session)
    .where(and(eq(session.userId, authUserId), sql`${session.campId} = current_camp_id()`));
}

// Deactivation removes access on the next request and ends existing sessions. It can't remove
// the last active Admin.
export async function deactivatePerson(db: Db, actor: Viewer, personId: string) {
  assertAccess(actor, "people");
  await db.transaction(async (tx) => {
    const admins = await lockActiveHolders(tx, "admin");
    const [before] = await tx.select().from(person).where(eq(person.id, personId)).for("update");
    const reason = await actingReason(tx, actor, personId);
    if (reason) throw forbidden(reason);
    if (admins.includes(personId) && admins.length <= 1) throw conflict("last_admin");

    if (!before?.active) return;
    await tx
      .update(person)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(person.id, personId));
    // Ends their sessions at this camp only; their sessions at other camps are theirs to keep.
    if (before.authUserId) await endCampSessions(tx, before.authUserId);
    await releaseForPerson(tx, actor.personId, personId);
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "person_deactivated",
      subjectType: "person",
      subjectId: personId,
    });
  });
}

// Reactivating someone gives them back the roles they kept, so it follows the same rule as
// deactivating: only a person who can do nothing the actor can't (issue #93).
export async function reactivatePerson(db: Db, actor: Viewer, personId: string) {
  assertAccess(actor, "people");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(person).where(eq(person.id, personId)).for("update");
    if (!before || before.active) return;
    const reason = await actingReason(tx, actor, personId);
    if (reason) throw forbidden(reason);
    await tx
      .update(person)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(person.id, personId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "person_reactivated",
      subjectType: "person",
      subjectId: personId,
    });
  });
}
