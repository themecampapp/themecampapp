// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isNull } from "drizzle-orm";
import { data } from "react-router";
import { campSettings } from "~/db/schema";
import type { Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { legalText } from "../legal";
import { renderMarkdown } from "../markdown.server";

// R68: the pilot agreement (legal/<dir>/pilot-agreement.md, open-source plan 3.6). Where the
// instance uses one (config legal.pilotAgreement), a camp created in the console can't be used
// by its Admins until one of them accepts it; the version, who and when are kept with the camp.
// Change VERSION whenever the hosted service's text changes in substance.
export const AGREEMENT_VERSION = "2026-10-06";

// The agreement's text, or null where the instance doesn't use one.
export const agreementHtml = (env: Parameters<typeof legalText>[0]) => {
  const text = legalText(env, "pilot-agreement");
  return text === null ? null : renderMarkdown(text);
};

export async function acceptAgreement(db: Db, actor: Viewer) {
  if (!actor.isAdmin || actor.support) throw data({ reason: "admin_only" }, { status: 403 });
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(campSettings)
      .set({
        agreementVersion: AGREEMENT_VERSION,
        agreementAcceptedAt: new Date(),
        agreementAcceptedBy: actor.personId,
      })
      .where(isNull(campSettings.agreementAcceptedAt))
      .returning({ campId: campSettings.campId });
    // Already accepted (another Admin, or a second click): nothing to record.
    if (!row) return;
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "pilot_agreement_accepted",
      subjectType: "camp",
      subjectId: row.campId,
      after: { version: AGREEMENT_VERSION },
    });
  });
}

export async function agreementStatus(db: Db) {
  const [row] = await db
    .select({
      version: campSettings.agreementVersion,
      at: campSettings.agreementAcceptedAt,
      by: campSettings.agreementAcceptedBy,
    })
    .from(campSettings);
  return row;
}
