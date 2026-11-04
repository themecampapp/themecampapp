// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, like } from "drizzle-orm";
import { data } from "react-router";
import { appSetting } from "~/db/schema";
import type { Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import {
  DEFAULT_TEMPLATES,
  EDITABLE,
  isEditable,
  type MailKind,
  type TemplateText,
  templateProblem,
} from "../email-templates";
import { templateKey, templateOverride } from "../mail.server";

// Admin editing of email wording. An edit is stored over the built-in default; resetting
// deletes it. Every save and reset is audited with the before and after text.

function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin) throw data({ reason: "admin_only" }, { status: 403 });
}

export async function listTemplates(db: Db) {
  const saved = await db
    .select({ key: appSetting.key, updatedAt: appSetting.updatedAt })
    .from(appSetting)
    .where(like(appSetting.key, "email_template:%"));
  const byKind = new Map(saved.map((r) => [r.key.slice("email_template:".length), r.updatedAt]));
  return EDITABLE.map((t) => ({
    kind: t.kind,
    name: t.name,
    when: t.when,
    feature: t.feature ?? null,
    customizedAt: byKind.get(t.kind)?.toISOString() ?? null,
  }));
}

export async function getTemplate(db: Db, kind: string) {
  if (!isEditable(kind)) throw data({ reason: "not_found" }, { status: 404 });
  const def = EDITABLE.find((t) => t.kind === kind) as (typeof EDITABLE)[number];
  const override = await templateOverride(db, kind);
  return { ...def, current: override ?? DEFAULT_TEMPLATES[kind], customized: !!override };
}

const clean = (s: string) => s.replace(/\r\n?/g, "\n");

// Returns a problem to show the Admin, or null once saved.
export async function saveTemplate(
  db: Db,
  actor: Viewer,
  kind: MailKind,
  input: TemplateText,
): Promise<string | null> {
  assertAdmin(actor);
  const next = { subject: clean(input.subject).trim(), body: clean(input.body).trimEnd() };
  const problem = templateProblem(kind, next);
  if (problem) return problem;
  const before = (await templateOverride(db, kind)) ?? DEFAULT_TEMPLATES[kind];
  await db.transaction(async (tx) => {
    await tx
      .insert(appSetting)
      .values({ key: templateKey(kind), value: next })
      .onConflictDoUpdate({
        target: [appSetting.campId, appSetting.key],
        set: { value: next, updatedAt: new Date() },
      });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "email_template_saved",
      subjectType: "email_template",
      subjectId: kind,
      before,
      after: next,
    });
  });
  return null;
}

export async function resetTemplate(db: Db, actor: Viewer, kind: MailKind) {
  assertAdmin(actor);
  const before = await templateOverride(db, kind);
  if (!before) return;
  await db.transaction(async (tx) => {
    await tx.delete(appSetting).where(eq(appSetting.key, templateKey(kind)));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "email_template_reset",
      subjectType: "email_template",
      subjectId: kind,
      before,
      after: DEFAULT_TEMPLATES[kind],
    });
  });
}
