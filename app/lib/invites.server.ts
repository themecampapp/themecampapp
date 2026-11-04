// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { data } from "react-router";
import { invite, person } from "~/db/schema";
import { assertAccess, type Viewer } from "./access.server";
import { audit } from "./audit.server";
import { SHARES_CONTACT } from "./contact-sharing.server";
import { getCampSettings } from "./data/camp-settings.server";
import { parseYears } from "./data/history.server";
import type { Db } from "./db.server";
import { normalizeEmail } from "./email";
import { loginManagementReason } from "./login-management";
import { notSentError, sendMail, sendMailBatch } from "./mail.server";
import { hitRateLimit } from "./rate-limit.server";
import { accessOf, heldRoles } from "./role-access.server";
import { endCampSessions, lockPersonForLoginManagement } from "./roles.server";

type MailEnv = import("./mail.server").MailEnv;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const conflict = (reason: string) => data({ reason }, { status: 409 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteUrl(env: MailEnv, email: string) {
  const url = new URL("/sign-in", env.APP_URL);
  url.searchParams.set("email", email);
  return url.toString();
}

// The person who already has this email (active first), so Leads don't create a duplicate.
export async function personWithEmail(
  db: Db | Tx,
  rawEmail: string,
  excludeId?: string,
): Promise<{ id: string; name: string; active: boolean } | null> {
  const email = normalizeEmail(rawEmail);
  const [p] = await db
    .select({
      id: person.id,
      legalName: person.legalName,
      playaName: person.playaName,
      active: person.active,
    })
    .from(person)
    .where(
      and(sql`lower(${person.email}) = ${email}`, excludeId ? ne(person.id, excludeId) : undefined),
    )
    .orderBy(desc(person.active))
    .limit(1);
  if (!p) return null;
  return {
    id: p.id,
    name: p.playaName ? `${p.playaName} (${p.legalName})` : p.legalName,
    active: p.active,
  };
}

// Why someone can't be invited right now, or null if they can.
export async function inviteBlocker(db: Db | Tx, personId: string): Promise<string | null> {
  const [p] = await db.select().from(person).where(eq(person.id, personId));
  if (!p) return "not_found";
  if (!p.active) return "inactive";
  if (p.authUserId) return "already_signed_in";
  if (!p.email || !EMAIL_RE.test(p.email)) return "no_email";
  const shared = await db
    .select({ id: person.id })
    .from(person)
    .where(and(eq(person.email, p.email), ne(person.id, p.id), eq(person.active, true)))
    .limit(1);
  if (shared.length) return "shared_email";
  return null;
}

// Creates (or re-sends) the pending invite for one person and emails them. Lead-facing, so a
// failed send is reported rather than hidden.
export async function sendInvite(db: Db, env: MailEnv, actor: Viewer, personId: string) {
  const email = await db.transaction(async (tx) => {
    const p = await lockPersonForLoginManagement(tx, actor, personId);
    const blocker = await inviteBlocker(tx, personId);
    if (blocker) throw conflict(blocker);
    if (!(await hitRateLimit(tx, `invite:${personId}`, { windowSeconds: 86400, max: 3 }))) {
      throw conflict("invite_rate_limited");
    }
    const email = p.email as string;
    const [pending] = await tx
      .select()
      .from(invite)
      .where(and(eq(invite.personId, personId), eq(invite.status, "pending")))
      .for("update");
    if (pending && pending.email !== email) {
      await tx
        .update(invite)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(invite.id, pending.id));
    }
    if (pending && pending.email === email) {
      await tx
        .update(invite)
        .set({ sentAt: new Date(), sentByPersonId: actor.personId })
        .where(eq(invite.id, pending.id));
    } else {
      await tx
        .insert(invite)
        .values({ personId, email, sentByPersonId: actor.personId, sentAt: new Date() });
    }
    await audit(tx, {
      actorPersonId: actor.personId,
      action: pending?.email === email ? "invite_resent" : "invite_sent",
      subjectType: "person",
      subjectId: personId,
      after: { email },
    });
    return email;
  });
  const sent = await sendMail(db, env, "invite", email, { url: inviteUrl(env, email) });
  if (sent !== "sent") throw notSentError(sent);
}

// Returning campers who can be invited in one go: came last season, active, a valid email no
// other active person shares, and no pending or linked invite yet.
export async function bulkInviteCandidates(db: Db | Tx, actor: Viewer) {
  assertAccess(actor, "people");
  const rows = await db.execute<{
    id: string;
    legal_name: string;
    playa_name: string | null;
    email: string;
  }>(sql`
    select p.id, p.legal_name, p.playa_name, p.email
    from person p
    join participation pa on pa.person_id = p.id
    join burn b on b.id = pa.burn_id and b.year = current_year() - 1
    where pa.attended = true
      and p.active
      and p.auth_user_id is null
      and p.email is not null
      and not exists (select 1 from invite i where i.person_id = p.id and i.status in ('pending','linked'))
      and not exists (
        select 1 from person o where o.email = p.email and o.id <> p.id and o.active
      )
    order by coalesce(p.playa_name, p.legal_name)
  `);
  // Inviting someone hands over their sign-in, so only people the actor may manage
  // (login-management.ts), checked here rather than in SQL so there's one rule.
  const held = await heldRoles(
    db,
    rows.map((r) => r.id),
  );
  const { features } = await getCampSettings(db);
  return rows.filter(
    (r) =>
      EMAIL_RE.test(r.email) && !loginManagementReason(actor, accessOf(held.get(r.id)), features),
  );
}

export async function sendBulkInvites(db: Db, env: MailEnv, actor: Viewer, personIds: string[]) {
  assertAccess(actor, "people");
  if (!personIds.length) return { sent: 0, failed: [] as string[], held: {} };
  const eligible = await db.transaction(async (tx) => {
    // Lock in a stable order, then recheck eligibility and roles against current data.
    await tx
      .select({ id: person.id })
      .from(person)
      .where(inArray(person.id, personIds))
      .orderBy(person.id)
      .for("update");
    const eligible = (await bulkInviteCandidates(tx, actor)).filter((r) =>
      personIds.includes(r.id),
    );
    if (!eligible.length) return eligible;
    await tx.insert(invite).values(
      eligible.map((r) => ({
        personId: r.id,
        email: r.email,
        sentByPersonId: actor.personId,
        sentAt: new Date(),
      })),
    );
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "bulk_invite_sent",
      subjectType: "invite",
      subjectId: null,
      after: { count: eligible.length, personIds: eligible.map((r) => r.id) },
    });
    return eligible;
  });
  if (!eligible.length) return { sent: 0, failed: [] as string[], held: {} };
  return sendMailBatch(
    db,
    env,
    "invite",
    eligible.map((r) => ({ to: r.email, url: inviteUrl(env, r.email) })),
  );
}

// A Lead can correct someone's email only before they've signed in. A pending invite to the
// old address is revoked and re-sent to the new one.
export async function changeEmailBeforeSignIn(
  db: Db,
  env: MailEnv,
  actor: Viewer,
  personId: string,
  rawEmail: string,
) {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email)) throw data({ reason: "invalid_email" }, { status: 400 });
  const hadPending = await db.transaction(async (tx) => {
    const p = await lockPersonForLoginManagement(tx, actor, personId);
    if (p.authUserId) throw conflict("linked_email_locked");
    if (p.email === email) return false;
    if ((await personWithEmail(tx, email, personId))?.active) throw conflict("email_in_use");
    await tx.update(person).set({ email, updatedAt: new Date() }).where(eq(person.id, personId));
    const revoked = await tx
      .update(invite)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(invite.personId, personId), eq(invite.status, "pending")))
      .returning({ id: invite.id });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "email_changed_by_lead",
      subjectType: "person",
      subjectId: personId,
      before: { email: p.email },
      after: { email },
    });
    return revoked.length > 0;
  });
  if (hadPending) await sendInvite(db, env, actor, personId);
}

// Detaches a login from a person (e.g. linked to a wrong address). The Lead then re-invites.
export async function unlinkLogin(db: Db, actor: Viewer, personId: string) {
  await db.transaction(async (tx) => {
    const p = await lockPersonForLoginManagement(tx, actor, personId);
    if (!p.authUserId) return;
    await tx
      .update(person)
      .set({ authUserId: null, updatedAt: new Date() })
      .where(eq(person.id, personId));
    await endCampSessions(tx, p.authUserId);
    await tx
      .update(invite)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(invite.personId, personId), inArray(invite.status, ["pending", "linked"])));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "login_unlinked",
      subjectType: "person",
      subjectId: personId,
      before: { authUserId: p.authUserId },
    });
  });
}

export type InviteStatus = "not_invited" | "invited" | "signed_in" | "rsvpd" | "rsvpd_by_lead";

// People list for Leads, with the derived invite status for the given season. Without
// `contact` (Private details & notes, issue #93), emails show, and can be searched, only for
// people who share theirs in the directory.
export async function listPeople(
  db: Db,
  opts: {
    q?: string;
    year: number;
    includeInactive?: boolean;
    campYear?: number;
    contact: boolean;
  },
) {
  const q = opts.q?.trim();
  const rows = await db.execute<{
    id: string;
    legal_name: string;
    playa_name: string | null;
    email: string | null;
    shares: boolean;
    active: boolean;
    auth_user_id: string | null;
    pending: boolean;
    intent: string | null;
    intent_by_lead: boolean;
    camp_years: string | null;
  }>(sql`
    select p.id, p.legal_name, p.playa_name, p.email, p.active, p.auth_user_id,
      ${SHARES_CONTACT} as shares,
      exists (select 1 from invite i where i.person_id = p.id and i.status = 'pending') as pending,
      pa.intent,
      (pa.updated_by_person_id is not null and pa.updated_by_person_id <> p.id) as intent_by_lead,
      (select string_agg(b.year::text, ',' order by b.year)
        from participation cy join burn b on b.id = cy.burn_id
        where cy.person_id = p.id and cy.attended and b.year < ${opts.year}) as camp_years
    from person p
    left join participation pa on pa.person_id = p.id
      and pa.burn_id = (select id from burn where year = ${opts.year})
    where (${opts.includeInactive ?? false} or p.active)
      and (${opts.campYear ?? null}::int is null or exists (
        select 1 from participation cy join burn b on b.id = cy.burn_id
        where cy.person_id = p.id and cy.attended and b.year = ${opts.campYear ?? null}::int
      ))
      and (${q ?? null}::text is null
        or p.legal_name ilike ${`%${q ?? ""}%`}
        or p.playa_name ilike ${`%${q ?? ""}%`}
        or (p.email ilike ${`%${q ?? ""}%`} and (${opts.contact}
          or ${SHARES_CONTACT})))
    order by coalesce(p.playa_name, p.legal_name)
  `);
  return rows.map((r) => {
    let status: InviteStatus = "not_invited";
    if (r.intent) status = r.intent_by_lead ? "rsvpd_by_lead" : "rsvpd";
    else if (r.auth_user_id) status = "signed_in";
    else if (r.pending) status = "invited";
    return {
      id: r.id,
      legalName: r.legal_name,
      playaName: r.playa_name,
      email: opts.contact || r.shares ? r.email : null,
      active: r.active,
      campYears: parseYears(r.camp_years),
      intent: r.intent,
      // Status is one step along the way (an RSVP outranks signing in); signedIn is the fact.
      signedIn: r.auth_user_id !== null,
      status,
    };
  });
}
