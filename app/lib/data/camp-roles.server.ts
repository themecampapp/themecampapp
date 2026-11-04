// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { data } from "react-router";
import { campRole, campSettings, memberRole, person } from "~/db/schema";
import type { Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import {
  type Access,
  AREAS,
  type AreaKey,
  BUILTIN_DEFAULTS,
  type BuiltinRole,
  MAX_CUSTOM_ROLES,
  RESERVED_ROLE_NAMES,
  resolveRole,
} from "../permissions";

// Issue #93: the camp's roles (Admin → Roles). Lead and Treasurer are presets an Admin can
// change and reset; custom roles are the camp's own. Admin isn't stored here: it's fixed.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const refuse = (reason: string, status = 400) => data({ reason }, { status });

export const BUILTIN_LABEL: Record<BuiltinRole, string> = { lead: "Lead", treasurer: "Treasurer" };

export type RoleCard = {
  // "lead", "treasurer", or the custom role's id: its address under /admin/roles.
  key: string;
  builtin: BuiltinRole | null;
  name: string;
  description: string;
  access: Access;
  customized: boolean;
  newAreas: AreaKey[];
  archived: boolean;
  holders: Array<{ personId: string; name: string }>;
};

function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin) throw refuse("admin_only", 403);
}

const isBuiltin = (key: string): key is BuiltinRole => key === "lead" || key === "treasurer";

// Who holds each role now (active people only), by built-in role name or custom role id.
async function holdersByRole(db: Db | Tx) {
  const rows = await db
    .select({
      role: memberRole.role,
      customRoleId: memberRole.customRoleId,
      personId: person.id,
      name: sql<string>`coalesce(${person.playaName}, ${person.legalName})`,
    })
    .from(memberRole)
    .innerJoin(person, eq(person.id, memberRole.personId))
    .where(and(isNull(memberRole.revokedAt), eq(person.active, true)))
    .orderBy(asc(sql`lower(coalesce(${person.playaName}, ${person.legalName}))`));
  const out = new Map<string, Array<{ personId: string; name: string }>>();
  for (const r of rows) {
    const key = r.customRoleId ?? r.role;
    out.set(key, [...(out.get(key) ?? []), { personId: r.personId, name: r.name }]);
  }
  return out;
}

function card(
  row: typeof campRole.$inferSelect | undefined,
  builtin: BuiltinRole | null,
  holders: Map<string, Array<{ personId: string; name: string }>>,
): RoleCard {
  const { access, newAreas } = resolveRole({ builtin, grants: row?.grants ?? null });
  const key = builtin ?? (row?.id as string);
  return {
    key,
    builtin,
    name: builtin ? BUILTIN_LABEL[builtin] : (row?.name ?? ""),
    description: row?.description ?? "",
    access,
    customized: !!builtin && !!row,
    newAreas,
    archived: !!row?.archivedAt,
    holders: holders.get(key) ?? [],
  };
}

export async function campRoles(db: Db) {
  const rows = await db
    .select()
    .from(campRole)
    .orderBy(asc(sql`lower(${campRole.name})`));
  const holders = await holdersByRole(db);
  const custom = rows.filter((r) => !r.builtin).map((r) => card(r, null, holders));
  return {
    builtins: (["lead", "treasurer"] as const).map((b) =>
      card(
        rows.find((r) => r.builtin === b),
        b,
        holders,
      ),
    ),
    custom: custom.filter((c) => !c.archived),
    archived: custom.filter((c) => c.archived),
    admins: holders.get("admin") ?? [],
  };
}

export async function findCampRole(db: Db, key: string): Promise<RoleCard | null> {
  const holders = await holdersByRole(db);
  if (isBuiltin(key)) {
    const [row] = await db.select().from(campRole).where(eq(campRole.builtin, key));
    return card(row, key, holders);
  }
  if (!/^[0-9a-f-]{36}$/i.test(key)) return null;
  const [row] = await db.select().from(campRole).where(eq(campRole.id, key));
  return row && !row.builtin ? card(row, null, holders) : null;
}

// The active custom roles, for the person page's "Add a role" list.
export async function activeCustomRoles(db: Db) {
  return db
    .select({ id: campRole.id, name: campRole.name })
    .from(campRole)
    .where(and(isNull(campRole.builtin), isNull(campRole.archivedAt)))
    .orderBy(asc(sql`lower(${campRole.name})`));
}

type Details = { name: string; description: string; grants: Access };

function cleanDetails(input: Details) {
  const name = input.name.trim().replace(/\s+/g, " ");
  const description = input.description.trim();
  if (!name) throw refuse("role_name_needed");
  if (name.length > 40) throw refuse("role_name_too_long");
  if (RESERVED_ROLE_NAMES.includes(name.toLowerCase())) throw refuse("role_name_reserved");
  if (description.length > 200) throw refuse("role_description_too_long");
  return { name, description: description || null };
}

// A name another active custom role already has (its unique index says so). Any other
// unique violation isn't about the name, so it isn't reported as one.
function nameTaken(e: unknown) {
  const err = e as { code?: string; constraint_name?: string; cause?: unknown };
  const pg = (err.cause ?? err) as { code?: string; constraint_name?: string };
  return pg.code === "23505" && pg.constraint_name === "camp_role_name_ux";
}

// The setup checklist's "Review what your Leads can see" (issue #93): done the first time an
// Admin changes a role, or says the roles look right.
const markReviewed = (tx: Tx) =>
  tx
    .update(campSettings)
    .set({ rolesReviewedAt: sql`coalesce(${campSettings.rolesReviewedAt}, now())` });

export async function confirmRolesReviewed(db: Db, actor: Viewer) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(campSettings)
      .set({ rolesReviewedAt: new Date() })
      .where(isNull(campSettings.rolesReviewedAt))
      .returning({ campId: campSettings.campId });
    if (!row) return;
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "roles_reviewed",
      subjectType: "camp",
      subjectId: row.campId,
    });
  });
}

// Changes to a camp's role definitions happen one at a time: the custom-role cap and the
// first save of a customized Lead or Treasurer (no row yet to lock) both depend on it.
const lockRoleDefinitions = (tx: Tx) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext('camp_role:' || current_camp_id()::text))`);

// The areas where `next` gives less than `before`: what holders would lose.
export function lowered(before: Access, next: Access) {
  const rank = { none: 0, view: 1, manage: 2 } as const;
  return AREAS.filter((a) => rank[next[a.key]] < rank[before[a.key]]).map((a) => a.label);
}

export type SaveResult =
  | { ok: true; id: string }
  // Nothing saved: the change takes something away from people who hold the role, and the
  // Admin hasn't confirmed it yet.
  | { ok: false; lost: string[]; holders: string[] };

export async function createRole(db: Db, actor: Viewer, input: Details): Promise<string> {
  assertAdmin(actor);
  const { name, description } = cleanDetails(input);
  try {
    return await db.transaction(async (tx) => {
      await lockRoleDefinitions(tx);
      await markReviewed(tx);
      const [{ n }] = await tx
        .select({ n: count() })
        .from(campRole)
        .where(and(isNull(campRole.builtin), isNull(campRole.archivedAt)));
      if (n >= MAX_CUSTOM_ROLES) throw refuse("too_many_roles", 409);
      const [row] = await tx
        .insert(campRole)
        .values({ name, description, grants: input.grants })
        .returning({ id: campRole.id });
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "role_defined",
        subjectType: "camp_role",
        subjectId: row.id,
        after: { name, grants: input.grants },
      });
      return row.id;
    });
  } catch (e) {
    if (nameTaken(e)) throw refuse("role_name_taken", 409);
    throw e;
  }
}

// Saves what a role allows (and, for a custom role, its name and description). Unless
// `confirmed`, a change that takes something away from current holders isn't saved and comes
// back as the list of what they'd lose, for the Admin to confirm.
export async function saveRole(
  db: Db,
  actor: Viewer,
  key: string,
  input: Details & { confirmed: boolean },
): Promise<SaveResult> {
  assertAdmin(actor);
  const details = isBuiltin(key) ? null : cleanDetails(input);
  try {
    return await db.transaction(async (tx) => {
      await lockRoleDefinitions(tx);
      await markReviewed(tx);
      const [row] = await tx
        .select()
        .from(campRole)
        .where(isBuiltin(key) ? eq(campRole.builtin, key) : eq(campRole.id, key))
        .for("update");
      if (!isBuiltin(key) && (!row || row.builtin)) throw refuse("not_found", 404);
      if (row?.archivedAt) throw refuse("role_archived", 409);
      const builtin = isBuiltin(key) ? key : null;
      const before = resolveRole({ builtin, grants: row?.grants ?? null }).access;
      const lost = lowered(before, input.grants);
      if (lost.length && !input.confirmed) {
        const holders = (await holdersByRole(tx)).get(key) ?? [];
        if (holders.length) return { ok: false, lost, holders: holders.map((h) => h.name) };
      }
      let id = row?.id;
      if (row) {
        await tx
          .update(campRole)
          .set({ grants: input.grants, ...(details ?? {}), updatedAt: new Date() })
          .where(eq(campRole.id, row.id));
      } else {
        [{ id }] = await tx
          .insert(campRole)
          .values({ builtin, grants: input.grants })
          .returning({ id: campRole.id });
      }
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "role_updated",
        subjectType: "camp_role",
        subjectId: id as string,
        before: { name: row?.name ?? builtin, grants: before },
        after: { name: details?.name ?? builtin, grants: input.grants },
      });
      return { ok: true, id: id as string };
    });
  } catch (e) {
    if (nameTaken(e)) throw refuse("role_name_taken", 409);
    throw e;
  }
}

// Lead or Treasurer back to the app's defaults.
export async function resetRole(db: Db, actor: Viewer, builtin: BuiltinRole) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    await lockRoleDefinitions(tx);
    await markReviewed(tx);
    const [row] = await tx.delete(campRole).where(eq(campRole.builtin, builtin)).returning();
    if (!row) return;
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "role_reset",
      subjectType: "camp_role",
      subjectId: row.id,
      before: { name: builtin, grants: row.grants },
      after: { name: builtin, grants: BUILTIN_DEFAULTS[builtin] },
    });
  });
}

// Archives a custom role: everyone holding it loses it now (each one audited). It stays in the
// database for the history, and its name can be used again.
export async function archiveRole(db: Db, actor: Viewer, id: string) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    await lockRoleDefinitions(tx);
    await markReviewed(tx);
    const [row] = await tx.select().from(campRole).where(eq(campRole.id, id)).for("update");
    if (!row || row.builtin) throw refuse("not_found", 404);
    if (row.archivedAt) return;
    await tx.update(campRole).set({ archivedAt: new Date() }).where(eq(campRole.id, id));
    const revoked = await tx
      .update(memberRole)
      .set({ revokedAt: new Date(), revokedByPersonId: actor.personId })
      .where(and(eq(memberRole.customRoleId, id), isNull(memberRole.revokedAt)))
      .returning({ personId: memberRole.personId });
    for (const r of revoked) {
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "role_revoked",
        subjectType: "person",
        subjectId: r.personId,
        before: { role: "custom", customRoleId: id, name: row.name },
      });
    }
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "role_archived",
      subjectType: "camp_role",
      subjectId: id,
      before: { name: row.name, holders: revoked.length },
    });
  });
}

// R51 and issue #93: who can see members' private details and dues, from the camp's own
// roles, for the "Who can see what" notice. Admins always can.
export async function whoSees(db: Db, features: { dues: boolean }) {
  const { builtins, custom } = await campRoles(db);
  const PLURAL: Record<BuiltinRole, string> = { lead: "Leads", treasurer: "Treasurers" };
  const name = (r: RoleCard) =>
    r.builtin ? PLURAL[r.builtin] : `people with the “${r.name}” role`;
  const roles = [...builtins, ...custom];
  return {
    private: ["Admins", ...roles.filter((r) => r.access.private !== "none").map(name)],
    dues: features.dues
      ? ["Admins", ...roles.filter((r) => r.access.dues !== "none").map(name)]
      : null,
  };
}
