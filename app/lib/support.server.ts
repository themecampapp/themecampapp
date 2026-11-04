// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { data } from "react-router";
import { campSettings, supportGrant } from "~/db/schema";
import type { Viewer } from "./access.server";
import { audit } from "./audit.server";
import type { Db } from "./db.server";
import { DURATIONS, type Duration } from "./support";

// Support access (R39, R40, R42a), read-only for the pilot. A camp's Admin grants the Theme
// Camp App operator access for a set time; the operator opens the camp from the console with a
// single-use token, which becomes a support cookie on the camp's host. Every page the operator
// views is in the camp's Activity, the Worker refuses any change made with the cookie, and the
// camp's Admins are emailed when access starts and ends. Revoking or expiry ends it at once.

export const SUPPORT_COOKIE = "__Secure-support";

const refuse = (reason: string, status = 400) => data({ reason }, { status });

function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin || actor.support) throw data({ reason: "admin_only" }, { status: 403 });
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const active = () => and(isNull(supportGrant.revokedAt), gt(supportGrant.expiresAt, sql`now()`));

export async function activeGrant(db: Db) {
  const [g] = await db
    .select({
      id: supportGrant.id,
      expiresAt: supportGrant.expiresAt,
      createdAt: supportGrant.createdAt,
      opened: sql<boolean>`${supportGrant.tokenUsedAt} is not null`,
    })
    .from(supportGrant)
    .where(active())
    .orderBy(desc(supportGrant.expiresAt))
    .limit(1);
  return g ?? null;
}

export async function recentGrants(db: Db) {
  return db
    .select({
      id: supportGrant.id,
      createdAt: supportGrant.createdAt,
      expiresAt: supportGrant.expiresAt,
      revokedAt: supportGrant.revokedAt,
      opened: sql<boolean>`${supportGrant.tokenUsedAt} is not null`,
    })
    .from(supportGrant)
    .orderBy(desc(supportGrant.createdAt))
    .limit(10);
}

// An Admin grants read-only support access for one of the preset durations. One grant at a
// time: a new one replaces any that's still running.
export async function grantSupport(db: Db, actor: Viewer, duration: string) {
  assertAdmin(actor);
  const hours = DURATIONS[duration as Duration];
  if (!hours) throw refuse("support_duration_needed");
  return db.transaction(async (tx) => {
    // One grant at a time, even for two grants made at once: the camp's settings row is the lock.
    await tx.select({ id: campSettings.campId }).from(campSettings).for("update");
    const replaced = await tx
      .update(supportGrant)
      .set({
        revokedAt: new Date(),
        revokedByPersonId: actor.personId,
        endedNotifiedAt: new Date(),
      })
      .where(active())
      .returning({ id: supportGrant.id });
    const [g] = await tx
      .insert(supportGrant)
      .values({
        createdByPersonId: actor.personId,
        expiresAt: sql`now() + make_interval(hours => ${hours})`,
      })
      .returning({ id: supportGrant.id, expiresAt: supportGrant.expiresAt });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "support_granted",
      subjectType: "support_grant",
      subjectId: g.id,
      after: { hours, expiresAt: g.expiresAt.toISOString(), changes: false },
    });
    // The caller tells the Admins a replaced grant ended, as for a revoke.
    return { ...g, replaced: replaced.length > 0 };
  });
}

// Ends the running grant now. Returns whether there was one (to email the Admins).
export async function revokeSupport(db: Db, actor: Viewer): Promise<boolean> {
  assertAdmin(actor);
  return db.transaction(async (tx) => {
    const ended = await tx
      .update(supportGrant)
      .set({
        revokedAt: new Date(),
        revokedByPersonId: actor.personId,
        endedNotifiedAt: new Date(),
      })
      .where(active())
      .returning({ id: supportGrant.id });
    for (const g of ended) {
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "support_revoked",
        subjectType: "support_grant",
        subjectId: g.id,
      });
    }
    return ended.length > 0;
  });
}

// Grants that ran out without an "ended" email yet: marks them and says whether any did, so
// the caller can email the Admins exactly once.
export async function settleExpired(db: Db): Promise<boolean> {
  const rows = await db
    .update(supportGrant)
    .set({ endedNotifiedAt: new Date() })
    .where(
      and(
        isNull(supportGrant.revokedAt),
        isNull(supportGrant.endedNotifiedAt),
        sql`${supportGrant.expiresAt} <= now()`,
      ),
    )
    .returning({ id: supportGrant.id });
  for (const g of rows) {
    await audit(db, {
      actorPersonId: null,
      action: "support_expired",
      subjectType: "support_grant",
      subjectId: g.id,
    });
  }
  return rows.length > 0;
}

// /support/enter: a valid, unused, unexpired token for a running grant of this camp becomes a
// support session. Returns the new cookie value and when it must end, or null.
export async function enterSupport(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  const session = randomSecret();
  const sessionHash = await sha256(session);
  return db.transaction(async (tx) => {
    const [g] = await tx
      .update(supportGrant)
      .set({ tokenUsedAt: new Date(), sessionHash })
      .where(
        and(
          eq(supportGrant.tokenHash, tokenHash),
          isNull(supportGrant.tokenUsedAt),
          gt(supportGrant.tokenExpiresAt, sql`now()`),
          active(),
        ),
      )
      .returning({
        id: supportGrant.id,
        expiresAt: supportGrant.expiresAt,
        operatorId: supportGrant.openedByOperatorId,
      });
    if (!g?.operatorId) return null;
    await audit(tx, {
      actorPersonId: null,
      actorOperatorId: g.operatorId,
      action: "support_opened",
      subjectType: "support_grant",
      subjectId: g.id,
    });
    return { session, expiresAt: g.expiresAt };
  });
}

// The running grant a support cookie belongs to, or null (expired, revoked, replaced, or not
// this camp's: the lookup runs under this camp's row-level security).
export async function supportSession(db: Db, cookie: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(cookie)) return null;
  const [g] = await db
    .select({
      id: supportGrant.id,
      expiresAt: supportGrant.expiresAt,
      operatorId: supportGrant.openedByOperatorId,
    })
    .from(supportGrant)
    .where(and(eq(supportGrant.sessionHash, await sha256(cookie)), active()));
  return g?.operatorId ? { grantId: g.id, expiresAt: g.expiresAt, operatorId: g.operatorId } : null;
}

export function readSupportCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SUPPORT_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export const supportCookie = (value: string, maxAge: number) =>
  `${SUPPORT_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}`;

export const clearSupportCookie = () => supportCookie("", 0);

// The page views the operator makes under a grant, in the camp's Activity (R40).
export async function logSupportView(
  db: Db,
  session: { grantId: string; operatorId: string },
  path: string,
) {
  await audit(db, {
    actorPersonId: null,
    actorOperatorId: session.operatorId,
    action: "support_view",
    subjectType: "support_grant",
    subjectId: session.grantId,
    after: { path: path.replace(/\.data$/, "") },
  });
}
