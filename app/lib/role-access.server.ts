// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { campRole, memberRole } from "~/db/schema";
import type { Db } from "./db.server";
import { type Access, type Assignment, accessFromAssignments, type RoleKind } from "./permissions";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type Held = Assignment & {
  personId: string;
  // The custom role's id and name (null for the built-in roles).
  customRoleId: string | null;
  name: string | null;
};

// Issue #93: the roles each person holds now, with what the camp stored for them: its
// customized Lead or Treasurer, or the custom role's levels. Kept roles count for inactive
// people too (they come back with them). Only the given people, or everyone with a role.
export async function heldRoles(db: Db | Tx, personIds?: string[]) {
  if (personIds && personIds.length === 0) return new Map<string, Held[]>();
  const rows = await db
    .select({
      personId: memberRole.personId,
      role: memberRole.role,
      customRoleId: memberRole.customRoleId,
      grants: campRole.grants,
      archivedAt: campRole.archivedAt,
      name: campRole.name,
    })
    .from(memberRole)
    .leftJoin(
      campRole,
      or(eq(campRole.id, memberRole.customRoleId), eq(campRole.builtin, memberRole.role)),
    )
    .where(
      and(
        isNull(memberRole.revokedAt),
        personIds ? inArray(memberRole.personId, personIds) : undefined,
      ),
    );
  const out = new Map<string, Held[]>();
  for (const r of rows) {
    const held: Held = {
      personId: r.personId,
      role: r.role,
      customRoleId: r.customRoleId,
      grants: r.grants ?? null,
      archived: r.archivedAt !== null,
      name: r.name,
    };
    out.set(r.personId, [...(out.get(r.personId) ?? []), held]);
  }
  return out;
}

// What someone's roles let them do, and the kinds of role they hold (for labels only).
export function accessOf(held: readonly Held[] = []): {
  access: Access;
  isAdmin: boolean;
  kinds: RoleKind[];
} {
  const active = held.filter((h) => !h.archived);
  return {
    access: accessFromAssignments(active),
    isAdmin: active.some((h) => h.role === "admin"),
    kinds: (["admin", "lead", "treasurer", "custom"] as const).filter((k) =>
      active.some((h) => h.role === k),
    ),
  };
}

export async function personAccess(db: Db | Tx, personId: string) {
  return accessOf((await heldRoles(db, [personId])).get(personId));
}
