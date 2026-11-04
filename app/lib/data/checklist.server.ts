// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { count, eq, isNotNull, sql } from "drizzle-orm";
import { data } from "react-router";
import { campSettings, guide, invite, keyDate, person } from "~/db/schema";
import { inWorkspace, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import type { CampSettings } from "./camp-settings.server";
import { currentSeason } from "./participation.server";

// R24: a new camp's setup checklist. Each item is worked out from the camp's data every time,
// so it ticks itself off; nothing is stored but whether it's been dismissed. Only camps created
// in the console have one (camp.created_in_console), and only Admins and Leads see it.

// `external`: a link out of the app, opened in a new tab (the instance's support community).
export type ChecklistItem = {
  key: string;
  label: string;
  to: string;
  done: boolean;
  external?: boolean;
};

// `instance`: its name and support community (PRODUCT_NAME, SUPPORT_URL; open-source plan 2.4,
// 3.5). With no community, its item isn't on the list.
export async function setupChecklist(
  db: Db,
  settings: CampSettings,
  instance: { product: string; supportUrl: string | null },
): Promise<ChecklistItem[]> {
  const { supportUrl } = instance;
  const season = await currentSeason(db);
  const n = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
  const dates = await n(
    db.select({ n: count() }).from(keyDate).where(eq(keyDate.burnId, season.id)),
  );
  const guides = await n(db.select({ n: count() }).from(guide).where(eq(guide.published, true)));
  const people = await n(db.select({ n: count() }).from(person));
  // The first Admin's invite came from the operator (no sender); this is one the camp sent.
  const invites = await n(
    db.select({ n: count() }).from(invite).where(isNotNull(invite.sentByPersonId)),
  );
  return [
    {
      key: "contact",
      label: "Add the camp's contact email",
      to: "/admin/settings",
      done: !!settings.contactEmail,
    },
    {
      key: "features",
      label: "Choose which features the camp uses",
      to: "/admin/features",
      done: settings.setup.featuresReviewed,
    },
    // Issue #93: what Lead and Treasurer can do, before anyone else is given them.
    {
      key: "roles",
      label: "Review what your Leads can see",
      to: "/admin/roles",
      done: settings.setup.rolesReviewed,
    },
    {
      key: "dues",
      label: `Set ${season.year} dues (or turn dues off)`,
      to: settings.features.dues ? "/dues" : "/admin/features",
      done: !settings.features.dues || season.duesAmountCents != null,
    },
    {
      key: "dates",
      label: `Add a key date for ${season.year}`,
      to: "/dates",
      done: dates > 0,
    },
    {
      key: "guides",
      label: "Publish a guide (start from a ready-made one)",
      to: "/guide-editor",
      done: guides > 0,
    },
    {
      key: "people",
      label: "Add or import your people",
      to: "/people/import",
      done: people > 1,
    },
    {
      key: "invite",
      label: "Invite your first member",
      to: "/people",
      done: invites > 0,
    },
    // Issue #82: ticked once someone in the camp opens it (the app can't see who joined).
    ...(supportUrl
      ? [
          {
            key: "community",
            label: `Join the ${instance.product} admin community`,
            to: supportUrl,
            done: settings.setup.communityJoined,
            external: true,
          },
        ]
      : []),
  ];
}

// Whether this viewer sees the checklist on the home page now.
export function showsChecklist(viewer: Viewer, settings: CampSettings) {
  return (
    inWorkspace(viewer) &&
    !viewer.support &&
    settings.setup.createdInConsole &&
    !settings.setup.checklistDismissed
  );
}

export async function setChecklistDismissed(db: Db, actor: Viewer, dismissed: boolean) {
  // Leads and Admins may hide it; only Admins bring it back (from the Admin page).
  if (dismissed ? !inWorkspace(actor) : !actor.isAdmin) {
    throw data({ reason: dismissed ? "forbidden" : "admin_only" }, { status: 403 });
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(campSettings)
      .set({ checklistDismissedAt: dismissed ? new Date() : null })
      .returning({ campId: campSettings.campId });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: dismissed ? "setup_checklist_dismissed" : "setup_checklist_reopened",
      subjectType: "camp",
      subjectId: row.campId,
    });
  });
}

// Issue #82: someone opened the Theme Camp App Discord from the checklist. Kept from the first
// time; Leads and Admins (who see the checklist) only.
export async function setCommunityJoined(db: Db, actor: Viewer) {
  if (!inWorkspace(actor)) throw data({ reason: "forbidden" }, { status: 403 });
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(campSettings)
      .set({ communityJoinedAt: sql`coalesce(${campSettings.communityJoinedAt}, now())` })
      .returning({ campId: campSettings.campId });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "community_link_opened",
      subjectType: "camp",
      subjectId: row.campId,
    });
  });
}
