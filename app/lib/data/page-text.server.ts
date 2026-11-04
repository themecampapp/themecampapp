// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, inArray, like } from "drizzle-orm";
import { data } from "react-router";
import { appSetting } from "~/db/schema";
import type { Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import {
  isPageTextKey,
  PAGE_TEXTS,
  type PageTextKey,
  pageTextDef,
  pageTextKey,
  pageTextProblem,
} from "../page-text";

// A camp's page wording (issue #56, app/lib/page-text.ts): the camp's version where it has
// one, otherwise the default. Admins edit it; every save and reset is audited.

function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin) throw data({ reason: "admin_only" }, { status: 403 });
}

const saved = (value: unknown) => (typeof value === "string" ? value : null);

// The texts a page shows, in one query.
export async function pageTexts<K extends PageTextKey>(
  db: Db,
  keys: K[],
): Promise<Record<K, string>> {
  const rows = await db
    .select({ key: appSetting.key, value: appSetting.value })
    .from(appSetting)
    .where(inArray(appSetting.key, keys.map(pageTextKey)));
  const byKey = new Map(rows.map((r) => [r.key, saved(r.value)]));
  return Object.fromEntries(
    keys.map((k) => [k, byKey.get(pageTextKey(k)) ?? pageTextDef(k).default]),
  ) as Record<K, string>;
}

// Every text, for the editor: the camp's version, the default, and when it was changed.
export async function listPageTexts(db: Db) {
  const rows = await db
    .select({ key: appSetting.key, value: appSetting.value, updatedAt: appSetting.updatedAt })
    .from(appSetting)
    .where(like(appSetting.key, "page_text:%"));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return PAGE_TEXTS.map((t) => {
    const row = byKey.get(pageTextKey(t.key));
    const value = row ? saved(row.value) : null;
    return {
      ...t,
      current: value ?? t.default,
      customizedAt: value === null ? null : (row?.updatedAt.toISOString() ?? null),
    };
  });
}

async function current(db: Db, key: PageTextKey) {
  const [row] = await db
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, pageTextKey(key)));
  return row ? saved(row.value) : null;
}

// Returns a problem to show the Admin, or null once saved.
export async function savePageText(
  db: Db,
  actor: Viewer,
  key: string,
  input: string,
): Promise<string | null> {
  assertAdmin(actor);
  if (!isPageTextKey(key)) throw data({ reason: "not_found" }, { status: 404 });
  const next = input.replace(/\r\n?/g, "\n").trim();
  const problem = pageTextProblem(key, next);
  if (problem) return problem;
  const before = (await current(db, key)) ?? pageTextDef(key).default;
  if (before === next) return null;
  await db.transaction(async (tx) => {
    await tx
      .insert(appSetting)
      .values({ key: pageTextKey(key), value: next })
      .onConflictDoUpdate({
        target: [appSetting.campId, appSetting.key],
        set: { value: next, updatedAt: new Date() },
      });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "page_text_saved",
      subjectType: "page_text",
      subjectId: key,
      before: { name: pageTextDef(key).name, text: before },
      after: { name: pageTextDef(key).name, text: next },
    });
  });
  return null;
}

export async function resetPageText(db: Db, actor: Viewer, key: string) {
  assertAdmin(actor);
  if (!isPageTextKey(key)) throw data({ reason: "not_found" }, { status: 404 });
  const before = await current(db, key);
  if (before === null) return;
  await db.transaction(async (tx) => {
    await tx.delete(appSetting).where(eq(appSetting.key, pageTextKey(key)));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "page_text_reset",
      subjectType: "page_text",
      subjectId: key,
      before: { name: pageTextDef(key).name, text: before },
      after: { name: pageTextDef(key).name, text: pageTextDef(key).default },
    });
  });
}
