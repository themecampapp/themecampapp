// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { data } from "react-router";
import { user } from "~/db/auth-schema";
import { emailChange, leadQueueItem, person } from "~/db/schema";
import { audit } from "./audit.server";
import type { Db } from "./db.server";
import { normalizeEmail } from "./email";
import { notSentError, sendMail } from "./mail.server";
import { hitRateLimit } from "./rate-limit.server";
import { endCampSessions } from "./roles.server";
import type { CampRef } from "./tenancy.server";

// Self-service sign-in email change (R5), in two steps (security review S4), so a borrowed or
// stolen session alone can't move someone's sign-in to another mailbox:
//   1. the CURRENT sign-in address is sent a link to approve the change;
//   2. once approved, the NEW address is sent a link to confirm it.
// Each link shows a button, and only pressing it (a POST) acts, so mail scanners can't. When
// the change is made, the login is signed out everywhere, in every camp, its pending sign-in
// links are dropped, and the old address is told. Tokens are single-use, stored hashed, and
// the request expires in a day. Someone who has lost their old mailbox asks a Lead to unlink
// and re-invite them instead (an Admin or Treasurer, for one of those).

type MailEnv = import("./mail.server").MailEnv;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const refuse = (reason: string, status = 400) => data({ reason }, { status });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Another login, or an active person in any camp who isn't this login, already uses this
// address. The login spans camps, so this looks across all of them (email_in_use, a SECURITY
// DEFINER function that answers only yes or no).
async function emailTaken(db: Db | Tx, authUserId: string, email: string) {
  const rows = await db.execute<{ taken: boolean }>(
    sql`select email_in_use(${email}, ${authUserId}) as taken`,
  );
  return rows[0]?.taken === true;
}

async function queueConflict(db: Db | Tx, personId: string, newEmail: string) {
  const open = await db
    .select({ id: leadQueueItem.id })
    .from(leadQueueItem)
    .where(
      and(
        eq(leadQueueItem.personId, personId),
        eq(leadQueueItem.kind, "email_change_conflict"),
        eq(leadQueueItem.status, "open"),
      ),
    )
    .limit(1);
  if (!open.length) {
    await db
      .insert(leadQueueItem)
      .values({ kind: "email_change_conflict", personId, payload: { newEmail } });
  }
}

export async function requestEmailChange(db: Db, env: MailEnv, personId: string, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email) || email.length > 254) throw refuse("invalid_email");
  const [p] = await db.select().from(person).where(eq(person.id, personId));
  if (!p?.authUserId || !p.active) throw refuse("not_found", 404);
  const [login] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, p.authUserId));
  if (normalizeEmail(login?.email ?? "") === email) throw refuse("same_email");
  if (!(await hitRateLimit(db, `email_change:${personId}`, { windowSeconds: 86400, max: 5 }))) {
    throw refuse("email_change_rate_limited", 429);
  }
  if (await emailTaken(db, p.authUserId, email)) {
    await queueConflict(db, personId, email);
    throw refuse("email_unavailable", 409);
  }

  const current = normalizeEmail(login?.email ?? "");
  if (!EMAIL_RE.test(current)) throw refuse("not_found", 404);
  const token = newToken();
  await db.transaction(async (tx) => {
    // Only the newest request can be approved or confirmed.
    await tx
      .update(emailChange)
      .set({ usedAt: new Date() })
      .where(and(eq(emailChange.personId, personId), isNull(emailChange.usedAt)));
    await tx.insert(emailChange).values({
      personId,
      newEmail: email,
      approveTokenHash: await sha256(token),
      expiresAt: new Date(Date.now() + TTL_MS),
    });
    await audit(tx, {
      actorPersonId: personId,
      action: "email_change_requested",
      subjectType: "person",
      subjectId: personId,
      after: { newEmail: email },
    });
  });
  const url = new URL("/email/approve", env.APP_URL);
  url.searchParams.set("token", token);
  const sent = await sendMail(db, env, "email_change_approve", current, { url: url.toString() });
  if (sent !== "sent") throw notSentError(sent);
  return { email };
}

// The request an approval link is for, if it can still be approved (for the page's question).
async function approvable(db: Db | Tx, token: string, lock: boolean) {
  if (!token || token.length > 100) return null;
  const q = db
    .select()
    .from(emailChange)
    .where(
      and(
        eq(emailChange.approveTokenHash, await sha256(token)),
        isNull(emailChange.usedAt),
        isNull(emailChange.approvedAt),
        gt(emailChange.expiresAt, new Date()),
      ),
    );
  const [req] = lock ? await q.for("update") : await q;
  return req ?? null;
}

export async function viewApproval(db: Db, token: string) {
  const req = await approvable(db, token, false);
  return req ? { newEmail: req.newEmail } : null;
}

// Step 2: the current address approved (a POST from its link), so the new address is sent
// its own link to confirm. Any problem is one generic refusal.
export async function approveEmailChange(db: Db, env: MailEnv, token: string) {
  const confirmToken = newToken();
  const newEmail = await db.transaction(async (tx) => {
    const req = await approvable(tx, token, true);
    if (!req) throw refuse("email_change_invalid");
    const [p] = await tx.select().from(person).where(eq(person.id, req.personId));
    if (!p?.active || !p.authUserId) throw refuse("email_change_invalid");
    await tx
      .update(emailChange)
      .set({ approvedAt: new Date(), tokenHash: await sha256(confirmToken) })
      .where(eq(emailChange.id, req.id));
    await audit(tx, {
      actorPersonId: p.id,
      action: "email_change_approved",
      subjectType: "person",
      subjectId: p.id,
      after: { newEmail: req.newEmail },
    });
    return req.newEmail;
  });
  const url = new URL("/email/confirm", env.APP_URL);
  url.searchParams.set("token", confirmToken);
  const sent = await sendMail(db, env, "email_change_verify", newEmail, { url: url.toString() });
  if (sent !== "sent") throw notSentError(sent);
  return { newEmail };
}

// Applies a confirmed change: the login email (what sign-in links go to) and the person's
// email move together, here and in every other camp this login belongs to. Returns the new
// address. Any problem is one generic refusal. `dbForCamp` gives a database acting for another
// camp (each camp's person row is updated under that camp's own row-level security).
export async function confirmEmailChange(
  db: Db,
  env: MailEnv,
  token: string,
  dbForCamp: (camp: CampRef) => Db,
) {
  const invalid = () => refuse("email_change_invalid");
  if (!token || token.length > 100) throw invalid();
  const hash = await sha256(token);
  let oldEmail: string | null = null;
  let newEmail = "";
  let loginId = "";
  // "conflict" commits (the token is used up and Leads are told) before refusing.
  const outcome = await db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(emailChange)
      .where(
        and(
          eq(emailChange.tokenHash, hash),
          isNotNull(emailChange.approvedAt),
          isNull(emailChange.usedAt),
          gt(emailChange.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!req) throw invalid();
    await tx.update(emailChange).set({ usedAt: new Date() }).where(eq(emailChange.id, req.id));
    const [p] = await tx.select().from(person).where(eq(person.id, req.personId)).for("update");
    if (!p?.active || !p.authUserId) throw invalid();
    if (await emailTaken(tx, p.authUserId, req.newEmail)) {
      await queueConflict(tx, p.id, req.newEmail);
      return "conflict" as const;
    }
    const [login] = await tx.select().from(user).where(eq(user.id, p.authUserId));
    oldEmail = login?.email ?? p.email;
    newEmail = req.newEmail;
    loginId = p.authUserId;
    await tx
      .update(user)
      .set({ email: newEmail, emailVerified: true, updatedAt: new Date() })
      .where(eq(user.id, p.authUserId));
    await tx
      .update(person)
      .set({ email: newEmail, updatedAt: new Date() })
      .where(eq(person.id, p.id));
    await tx
      .update(emailChange)
      .set({ usedAt: new Date() })
      .where(
        and(eq(emailChange.personId, p.id), isNull(emailChange.usedAt), ne(emailChange.id, req.id)),
      );
    // Signed out here, and sign-in links still waiting at the old address stop working.
    await endCampSessions(tx, p.authUserId);
    await tx.execute(
      sql`delete from verification where strpos(value, ${JSON.stringify(normalizeEmail(oldEmail ?? ""))}) > 0`,
    );
    await audit(tx, {
      actorPersonId: p.id,
      action: "email_changed",
      subjectType: "person",
      subjectId: p.id,
      before: { email: oldEmail },
      after: { email: newEmail },
    });
    return "changed" as const;
  });
  if (outcome === "conflict") throw refuse("email_unavailable", 409);
  await updateOtherCamps(db, dbForCamp, loginId, newEmail);
  if (oldEmail && oldEmail !== newEmail) {
    await sendMail(db, env, "email_changed_notice", oldEmail, { url: env.APP_URL });
  }
  return { email: newEmail };
}

// The login's person in each of its other camps takes the new email too, so that camp's
// invites, directory and sign-in allowlist stay right, and the login is signed out there too.
// Each camp records it in its own log.
async function updateOtherCamps(
  db: Db,
  dbForCamp: (camp: CampRef) => Db,
  loginId: string,
  newEmail: string,
) {
  // Demo camps (fictional people) and camps being deleted are left alone.
  const camps = await db.execute<CampRef>(sql`
    select id, slug, kind, status from camp
    where id in (select login_camps(${loginId}))
      and id is distinct from current_camp_id()
      and kind = 'camp' and status <> 'pending_deletion'`);
  for (const camp of camps) {
    // The login's email has already changed; one camp failing here mustn't undo that or stop
    // the others. It's logged, and that camp's Leads can correct the person's email.
    await updateCamp(dbForCamp(camp), loginId, newEmail).catch((e) =>
      console.error(`email change: camp update failed: ${e instanceof Error ? e.name : "error"}`),
    );
  }
}

async function updateCamp(db: Db, loginId: string, newEmail: string) {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(person)
      .set({ email: newEmail, updatedAt: new Date() })
      .where(eq(person.authUserId, loginId))
      .returning({ id: person.id });
    await endCampSessions(tx, loginId);
    for (const p of changed) {
      await audit(tx, {
        actorPersonId: p.id,
        action: "email_changed",
        subjectType: "person",
        subjectId: p.id,
        after: { email: newEmail, via: "sign_in_email_change" },
      });
    }
  });
}
