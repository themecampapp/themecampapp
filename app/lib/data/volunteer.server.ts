// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { data } from "react-router";
import { campSettings, person, volunteerRole, volunteerSignup } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { cardLabel } from "../photos.server";
import { currentSeason } from "./participation.server";

// The camp's jobs (issue #6; "jobs" on screen since issue #106, which folded the elected
// positions in). Internally they're still volunteer roles and signups. Members sign up for jobs
// open to sign-up while they have open slots, up to the camp's limit of jobs per member if it
// has one (issue #29), which counts only jobs they picked themselves. Anyone with Volunteer:
// manage adds or removes anyone, past either limit, fills the jobs only Leads assign, and edits
// the list. Who's in a job is per season.

const refuse = (reason: string, status = 400) => data({ reason }, { status });

function assertLead(actor: Viewer) {
  assertAccess(actor, "volunteer");
}

export type RoleView = {
  id: string;
  title: string;
  commitment: string | null;
  description: string | null;
  slots: number;
  selfSignup: boolean;
  showInYearbook: boolean;
  retired: boolean;
  // isLead: a Lead or an Admin, so Admins can be offered "Make Lead" for anyone who isn't.
  signups: Array<{ personId: string; label: string; name: string; isLead: boolean }>;
  full: boolean;
  mine: boolean;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// What the camp's per-member limit counts (issue #106): jobs this season the person picked
// themselves, among the jobs members can still sign up for. A job a Lead gave them doesn't
// count, and neither does one that has since become a job only Leads fill (they can't leave
// it themselves, so it mustn't use up their pick), or one that's retired.
async function countPicked(db: Db | Tx, burnId: string, personId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(volunteerSignup)
    .innerJoin(volunteerRole, eq(volunteerRole.id, volunteerSignup.roleId))
    .where(
      and(
        eq(volunteerSignup.burnId, burnId),
        eq(volunteerSignup.personId, personId),
        eq(volunteerSignup.addedByPersonId, personId),
        eq(volunteerRole.selfSignup, true),
        eq(volunteerRole.retired, false),
      ),
    );
  return Number(n);
}

export async function pickedCount(db: Db, personId: string) {
  const season = await currentSeason(db);
  return countPicked(db, season.id, personId);
}

export async function listRoles(
  db: Db,
  viewerPersonId: string,
  opts: { includeRetired?: boolean } = {},
): Promise<RoleView[]> {
  const season = await currentSeason(db);
  const roles = await db
    .select()
    .from(volunteerRole)
    .orderBy(asc(volunteerRole.sort), asc(volunteerRole.title));
  const signups = await db
    .select({
      roleId: volunteerSignup.roleId,
      personId: person.id,
      legalName: person.legalName,
      playaName: person.playaName,
      showFirst: person.yearbookShowFirstName,
      isLead: sql<boolean>`exists (
        select 1 from member_role mr where mr.person_id = ${person.id}
          and mr.role in ('lead', 'admin') and mr.revoked_at is null)`,
    })
    .from(volunteerSignup)
    .innerJoin(person, eq(person.id, volunteerSignup.personId))
    .where(and(eq(volunteerSignup.burnId, season.id), eq(person.active, true)))
    .orderBy(asc(volunteerSignup.createdAt));
  return roles
    .filter((r) => opts.includeRetired || !r.retired)
    .map((r) => {
      const mine = signups.filter((s) => s.roleId === r.id);
      return {
        id: r.id,
        title: r.title,
        commitment: r.commitment,
        description: r.description,
        slots: r.slots,
        selfSignup: r.selfSignup,
        showInYearbook: r.showInYearbook,
        retired: r.retired,
        signups: mine.map((s) => ({
          personId: s.personId,
          label: cardLabel({
            playaName: s.playaName,
            legalName: s.legalName,
            showFirstName: s.showFirst,
          }).label,
          name: s.playaName ?? s.legalName,
          isLead: s.isLead,
        })),
        full: mine.length >= r.slots,
        mine: mine.some((s) => s.personId === viewerPersonId),
      };
    });
}

// Adds someone to a job. Members can only take an open slot in a job open to sign-up; Leads
// (force) can add anyone to any job, past both limits.
async function addSignup(
  db: Db,
  actorPersonId: string,
  roleId: string,
  personId: string,
  force: boolean,
) {
  const season = await currentSeason(db);
  await db.transaction(async (tx) => {
    // Lock the role so two people can't both take its last slot.
    const [role] = await tx
      .select()
      .from(volunteerRole)
      .where(eq(volunteerRole.id, roleId))
      .for("update");
    if (!role || role.retired) throw refuse("not_found", 404);
    if (!force && !role.selfSignup) throw refuse("job_assigned_only", 403);
    // Locking the person makes two signups of theirs at once take turns, so the camp's limit
    // on jobs per member holds.
    const [who] = await tx.select().from(person).where(eq(person.id, personId)).for("update");
    if (!who?.active) throw refuse("inactive_person", 409);
    if (!force) {
      const [settings] = await tx
        .select({ max: campSettings.volunteerMaxRoles })
        .from(campSettings);
      if (settings?.max != null && (await countPicked(tx, season.id, personId)) >= settings.max) {
        throw refuse("volunteer_max_reached", 409);
      }
    }
    const [{ taken }] = await tx
      .select({ taken: sql<number>`count(*)::int` })
      .from(volunteerSignup)
      .innerJoin(person, eq(person.id, volunteerSignup.personId))
      .where(
        and(
          eq(volunteerSignup.burnId, season.id),
          eq(volunteerSignup.roleId, roleId),
          eq(person.active, true),
        ),
      );
    if (!force && Number(taken) >= role.slots) throw refuse("role_full", 409);
    const rows = await tx
      .insert(volunteerSignup)
      .values({ burnId: season.id, roleId, personId, addedByPersonId: actorPersonId })
      .onConflictDoNothing()
      .returning({ id: volunteerSignup.id });
    if (rows.length) {
      await audit(tx, {
        actorPersonId,
        action: "volunteer_signed_up",
        subjectType: "person",
        subjectId: personId,
        after: { role: role.title, year: season.year },
      });
    }
  });
}

// Takes someone out of a job. Members leave only jobs open to sign-up; a job Leads assign is
// left through a Lead (force).
async function removeSignup(
  db: Db,
  actorPersonId: string,
  roleId: string,
  personId: string,
  force: boolean,
) {
  const season = await currentSeason(db);
  await db.transaction(async (tx) => {
    if (!force) {
      // Locked, as signing up locks it, so a Lead changing the job meanwhile takes turns.
      const [job] = await tx
        .select()
        .from(volunteerRole)
        .where(eq(volunteerRole.id, roleId))
        .for("update");
      if (job && !job.selfSignup) throw refuse("job_assigned_only", 403);
    }
    const removed = await tx
      .delete(volunteerSignup)
      .where(
        and(
          eq(volunteerSignup.burnId, season.id),
          eq(volunteerSignup.roleId, roleId),
          eq(volunteerSignup.personId, personId),
        ),
      )
      .returning({ id: volunteerSignup.id });
    if (!removed.length) return;
    const [role] = await tx.select().from(volunteerRole).where(eq(volunteerRole.id, roleId));
    await audit(tx, {
      actorPersonId,
      action: "volunteer_left",
      subjectType: "person",
      subjectId: personId,
      before: { role: role?.title, year: season.year },
    });
  });
}

export const signUp = (db: Db, viewer: Viewer, roleId: string) =>
  addSignup(db, viewer.personId, roleId, viewer.personId, false);

export const leaveRole = (db: Db, viewer: Viewer, roleId: string) =>
  removeSignup(db, viewer.personId, roleId, viewer.personId, false);

export async function leadAddSignup(db: Db, actor: Viewer, roleId: string, personId: string) {
  assertLead(actor);
  await addSignup(db, actor.personId, roleId, personId, true);
}

export async function leadRemoveSignup(db: Db, actor: Viewer, roleId: string, personId: string) {
  assertLead(actor);
  await removeSignup(db, actor.personId, roleId, personId, true);
}

export type RoleInput = {
  title: string;
  commitment: string;
  description: string;
  slots: string;
  // Checkboxes: present ("1") when ticked.
  selfSignup: boolean;
  showInYearbook: boolean;
};

function cleanRole(input: RoleInput) {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) throw refuse("role_title_needed");
  const slots = Number(input.slots || 1);
  if (!Number.isInteger(slots) || slots < 1 || slots > 50) throw refuse("role_bad_slots");
  return {
    title,
    commitment: input.commitment.trim().slice(0, 120) || null,
    description: input.description.trim().slice(0, 1000) || null,
    slots,
    selfSignup: input.selfSignup,
    showInYearbook: input.showInYearbook,
  };
}

export async function addRole(db: Db, actor: Viewer, input: RoleInput) {
  assertLead(actor);
  const values = cleanRole(input);
  const [last] = await db
    .select({ sort: sql<number>`coalesce(max(${volunteerRole.sort}), 0)` })
    .from(volunteerRole);
  const [row] = await db
    .insert(volunteerRole)
    .values({ ...values, sort: Number(last?.sort ?? 0) + 10 })
    .returning();
  await audit(db, {
    actorPersonId: actor.personId,
    action: "volunteer_role_added",
    subjectType: "volunteer_role",
    subjectId: row.id,
    after: values,
  });
}

export async function updateRole(db: Db, actor: Viewer, roleId: string, input: RoleInput) {
  assertLead(actor);
  const values = cleanRole(input);
  const [before] = await db.select().from(volunteerRole).where(eq(volunteerRole.id, roleId));
  if (!before) throw refuse("not_found", 404);
  await db.update(volunteerRole).set(values).where(eq(volunteerRole.id, roleId));
  await audit(db, {
    actorPersonId: actor.personId,
    action: "volunteer_role_updated",
    subjectType: "volunteer_role",
    subjectId: roleId,
    before: {
      title: before.title,
      commitment: before.commitment,
      description: before.description,
      slots: before.slots,
      selfSignup: before.selfSignup,
      showInYearbook: before.showInYearbook,
    },
    after: values,
  });
}

export async function setRoleRetired(db: Db, actor: Viewer, roleId: string, retired: boolean) {
  assertLead(actor);
  await db.update(volunteerRole).set({ retired }).where(eq(volunteerRole.id, roleId));
  await audit(db, {
    actorPersonId: actor.personId,
    action: retired ? "volunteer_role_retired" : "volunteer_role_restored",
    subjectType: "volunteer_role",
    subjectId: roleId,
  });
}

// This season's (non-retired) jobs for each of the given people, e.g. for the CSV export.
// `yearbookOnly`: just the jobs shown in the Yearbook's Who's who (its badges).
export async function rolesFor(db: Db, personIds: string[], opts: { yearbookOnly?: boolean } = {}) {
  const out = new Map<string, string[]>();
  if (!personIds.length) return out;
  const season = await currentSeason(db);
  const rows = await db
    .select({ personId: volunteerSignup.personId, title: volunteerRole.title })
    .from(volunteerSignup)
    .innerJoin(volunteerRole, eq(volunteerRole.id, volunteerSignup.roleId))
    .where(
      and(
        eq(volunteerSignup.burnId, season.id),
        eq(volunteerRole.retired, false),
        inArray(volunteerSignup.personId, personIds),
        opts.yearbookOnly ? eq(volunteerRole.showInYearbook, true) : undefined,
      ),
    )
    .orderBy(asc(volunteerRole.sort));
  for (const r of rows) out.set(r.personId, [...(out.get(r.personId) ?? []), r.title]);
  return out;
}

// Roles with open slots first (in their own order), then full ones: what still needs people.
export const openFirst = <T extends { full: boolean }>(roles: T[]) => [
  ...roles.filter((r) => !r.full),
  ...roles.filter((r) => r.full),
];

// Coming campers (Going or Leaning yes) with no job this season, for the Leads' staffing view.
export async function comingWithoutRole(db: Db) {
  const season = await currentSeason(db);
  return db.execute<{ id: string; name: string }>(sql`
    select p.id, coalesce(p.playa_name, p.legal_name) as name
    from person p
    join participation pa on pa.person_id = p.id and pa.burn_id = ${season.id}
    where p.active and pa.intent in ('going', 'leaning_yes')
      and not exists (
        select 1 from volunteer_signup s
        join volunteer_role r on r.id = s.role_id and not r.retired
        where s.person_id = p.id and s.burn_id = ${season.id})
    order by lower(coalesce(p.playa_name, p.legal_name))`);
}

// Issue #29: the camp's most jobs per member (blank for no limit). Admins only.
export async function saveVolunteerMax(db: Db, actor: Viewer, input: string) {
  if (!actor.isAdmin) throw refuse("admin_only", 403);
  const text = input.trim();
  const max = text === "" ? null : Number(text);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > 20)) {
    throw refuse("volunteer_bad_max");
  }
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ max: campSettings.volunteerMaxRoles }).from(campSettings);
    if ((before?.max ?? null) === max) return;
    await tx.update(campSettings).set({ volunteerMaxRoles: max, updatedAt: new Date() });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "volunteer_max_set",
      subjectType: "camp",
      subjectId: null,
      before: { max: before?.max ?? null },
      after: { max },
    });
  });
}
