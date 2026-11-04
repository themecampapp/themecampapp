// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createContext, data, type RouterContextProvider, redirect } from "react-router";
import { invite, leadQueueItem, person } from "~/db/schema";
import { audit } from "./audit.server";
import { logAuthEvent } from "./auth-log.server";
import { cloudflareContext, getAuth, getDb, getWriteDb } from "./context.server";
import type { Db } from "./db.server";
import { DEMO_ROLE, type DemoRole, demoRole } from "./demo";
import { normalizeEmail } from "./email";
import {
  type Access,
  ADMIN_ACCESS,
  type AreaKey,
  accessForRoles,
  areaForPattern,
  atLeast,
  type Level,
  type RoleKind,
} from "./permissions";
import { personAccess } from "./role-access.server";
import { clearSupportCookie, readSupportCookie, supportSession } from "./support.server";

export type Role = "lead" | "treasurer" | "admin";

export type Viewer = {
  personId: string;
  authUserId: string;
  legalName: string;
  playaName: string | null;
  isAdmin?: boolean; // Admins can do everything, plus the Admin tools (season rollover, emails)
  // Issue #93: what they can do, as a level in each area. Every check reads this, never the
  // role names.
  access: Access;
  // The kinds of role they hold, for labels only (feedback, sign-in notices). Never for access.
  roles: RoleKind[];
  // The Theme Camp App operator under a camp's support grant: sees what an Admin sees, read-only
  // (the Worker refuses every change made with a support cookie). personId is no one's.
  support?: { grantId: string; operatorId: string; expiresAt: string };
  // A visitor to the public demo camp (R67), viewing it as the seeded member, Lead or Admin they
  // chose (U20). Read-only whichever they pick: the demo
  // camp's writes are refused before any action runs, and its transactions are read-only.
  demo?: DemoRole;
};

// The personId a support viewer carries: a valid UUID that matches no person, so "my RSVP"
// and the like simply find nothing. Never written anywhere (support access is read-only).
export const SUPPORT_PERSON_ID = "00000000-0000-4000-8000-5e1f5e1f5e1f";

export type ViewerResult =
  | { status: "anonymous" }
  | { status: "not_member" }
  // A support cookie whose grant has ended (or was never this camp's).
  | { status: "support_ended" }
  | { status: "member"; viewer: Viewer };

export const viewerContext = createContext<Viewer | null>(null);

// Session -> person -> active membership -> roles. With `link`, a first sign-in is linked to
// the one person holding a pending invite for that exact email; anything ambiguous goes to
// the Lead queue instead. Guide routes call this with link: false (read-only).
export async function resolveViewer(
  request: Request,
  context: Readonly<RouterContextProvider>,
  { link }: { link: boolean },
): Promise<ViewerResult> {
  // The demo camp has no logins at all: a demo visit is the only way in, and it's valid there
  // only. Everywhere else the demo cookie is never looked at.
  const { camp: here } = context.get(cloudflareContext);
  if (here.kind === "demo") {
    const role = demoRole(request);
    if (!role) return { status: "anonymous" };
    const demoRoles: RoleKind[] = role === "member" ? [] : [role];
    const [p] = await getDb(context)
      .select()
      .from(person)
      .where(eq(person.id, DEMO_ROLE[role].personId));
    if (!p) return { status: "not_member" };
    return {
      status: "member",
      viewer: {
        personId: p.id,
        authUserId: "",
        legalName: p.legalName,
        playaName: p.playaName,
        isAdmin: role === "admin",
        access: accessForRoles(demoRoles),
        roles: demoRoles,
        demo: role,
      },
    };
  }
  // Support access comes first: the operator may also be an ordinary member of this camp
  // (R42a), and the support view is the one they asked for.
  const supportValue = readSupportCookie(request);
  if (supportValue) {
    const s = await supportSession(getDb(context), supportValue);
    if (!s) return { status: "support_ended" };
    return {
      status: "member",
      viewer: {
        personId: SUPPORT_PERSON_ID,
        authUserId: "",
        legalName: `${context.get(cloudflareContext).env.PRODUCT_NAME} support`,
        playaName: null,
        isAdmin: true,
        access: { ...ADMIN_ACCESS },
        roles: ["admin"],
        support: {
          grantId: s.grantId,
          operatorId: s.operatorId,
          expiresAt: s.expiresAt.toISOString(),
        },
      },
    };
  }
  const session = await getAuth(context).api.getSession({ headers: request.headers });
  if (!session) return { status: "anonymous" };
  // A session works only at the camp it was created at. The cookie is host-only already; this
  // also refuses a session row replayed or forged for another camp.
  const { camp } = context.get(cloudflareContext);
  if ((session.session as { campId?: string }).campId !== camp.id) return { status: "anonymous" };

  const db = getDb(context);
  const authUserId = session.user.id;
  let p: typeof person.$inferSelect | undefined = (
    await db.select().from(person).where(eq(person.authUserId, authUserId)).limit(1)
  )[0];
  if (!p && link) {
    // Writable even for a suspended camp: its members can still sign in and read.
    const writeDb = getWriteDb(context);
    p = await linkFirstSignIn(writeDb, authUserId, session.user.email);
    await logAuthEvent(writeDb, {
      event: p ? "account_linked" : "not_linked",
      email: session.user.email,
      personId: p?.id,
      request,
    });
  }
  if (!p?.active) return { status: "not_member" };

  // Issue #93: their roles with the camp's own settings for them (a customized Lead, custom
  // roles), read on every request, so a change applies on their next one.
  const { access, isAdmin, kinds } = await personAccess(db, p.id);
  return {
    status: "member",
    viewer: {
      personId: p.id,
      authUserId,
      legalName: p.legalName,
      playaName: p.playaName,
      isAdmin,
      access,
      roles: kinds,
    },
  };
}

async function linkFirstSignIn(db: Db, authUserId: string, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(invite)
      .where(and(eq(invite.email, email), eq(invite.status, "pending")))
      .for("update");

    const candidates = pending.length
      ? await tx
          .select()
          .from(person)
          .where(
            inArray(
              person.id,
              pending.map((i) => i.personId),
            ),
          )
      : [];
    const linkable = candidates.filter((c) => c.authUserId === null && c.active);

    if (pending.length !== 1 || linkable.length !== 1) {
      if (pending.length > 0) {
        const open = await tx
          .select({ id: leadQueueItem.id })
          .from(leadQueueItem)
          .where(and(eq(leadQueueItem.authUserId, authUserId), eq(leadQueueItem.status, "open")))
          .limit(1);
        if (open.length === 0) {
          await tx.insert(leadQueueItem).values({
            kind: "link_conflict",
            authUserId,
            payload: { email, invitedPersonIds: pending.map((i) => i.personId) },
          });
        }
      }
      return undefined;
    }

    const target = linkable[0];
    const [linked] = await tx
      .update(person)
      .set({ authUserId, updatedAt: new Date() })
      .where(and(eq(person.id, target.id), isNull(person.authUserId)))
      .returning();
    if (!linked) return undefined;
    await tx
      .update(invite)
      .set({ status: "linked", linkedAt: new Date() })
      .where(eq(invite.id, pending[0].id));
    await audit(tx, {
      actorPersonId: target.id,
      action: "account_linked",
      subjectType: "person",
      subjectId: target.id,
      after: { authUserId, email },
    });
    return linked;
  });
}

// Mutations must come from our own pages (defense in depth on top of SameSite cookies).
export function assertSameOrigin(request: Request, context: Readonly<RouterContextProvider>) {
  if (request.method === "GET" || request.method === "HEAD") return;
  // The Worker entry already refused cross-origin writes; this keeps the check next to the
  // pages that rely on it. APP_URL is the request's own camp origin.
  const { env } = context.get(cloudflareContext);
  if (request.headers.get("Origin") !== new URL(env.APP_URL).origin) {
    throw data({ reason: "cross_origin" }, { status: 403 });
  }
}

export function getViewer(context: Readonly<RouterContextProvider>): Viewer {
  const viewer = context.get(viewerContext);
  if (!viewer) throw new Error("getViewer called outside the _app layout");
  return viewer;
}

const forbidden = () => data({ reason: "forbidden" }, { status: 403 });

// Issue #93: whether the viewer has at least `level` in `area`.
export function can(viewer: Pick<Viewer, "access">, area: AreaKey, level: Level = "view") {
  return atLeast(viewer.access[area], level);
}

// Data-layer guard for a change (or, with "view", a read).
export function assertAccess(
  viewer: Pick<Viewer, "access">,
  area: AreaKey,
  level: Level = "manage",
) {
  if (!can(viewer, area, level)) throw forbidden();
}

export function requireAccess(
  context: Readonly<RouterContextProvider>,
  area: AreaKey,
  level: Level = "view",
): Viewer {
  const viewer = getViewer(context);
  assertAccess(viewer, area, level);
  return viewer;
}

// The Lead workspace (the Lead home, the tour, the Lead handbook, the setup checklist) is for
// people who can see the camp's people: exactly the Leads and Admins of before issue #93.
export function inWorkspace(viewer: Pick<Viewer, "access">) {
  return can(viewer, "people", "view");
}

// Every page of the Lead tools belongs to an area (app/lib/permissions.ts). Run in the _app
// middleware with the matched route's pattern, so ".data" requests and paths that differ only
// in case or encoding are checked the same as the page itself. Reading needs the route's
// level (view unless it says more); any change needs manage unless it says less.
export function assertRouteAccess(viewer: Viewer, pattern: string, method: string) {
  const need = areaForPattern(pattern);
  if (!need) return;
  const reading = method === "GET" || method === "HEAD";
  if (!can(viewer, need.area, reading ? need.read : need.write)) throw forbidden();
}

export function requireAdmin(context: Readonly<RouterContextProvider>): Viewer {
  const viewer = getViewer(context);
  if (!viewer.isAdmin) throw data({ reason: "forbidden" }, { status: 403 });
  return viewer;
}

// Runs on every request under the _app layout.
export async function requireMember(request: Request, context: Readonly<RouterContextProvider>) {
  assertSameOrigin(request, context);
  const result = await resolveViewer(request, context, { link: true });
  if (result.status === "anonymous") {
    throw redirect(
      context.get(cloudflareContext).camp.kind === "demo" ? "/demo/enter" : "/sign-in",
    );
  }
  if (result.status === "support_ended") {
    // The grant ended or was revoked: the cookie goes, and so does access.
    const cf = context.get(cloudflareContext);
    cf.setCookies = [...(cf.setCookies ?? []), clearSupportCookie()];
    throw data({ reason: "support_ended" }, { status: 403 });
  }
  if (result.status === "not_member") throw data({ reason: "not_member" }, { status: 403 });
  (context as RouterContextProvider).set(viewerContext, result.viewer);
  return result.viewer;
}
