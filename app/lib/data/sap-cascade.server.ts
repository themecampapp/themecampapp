// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { sapPass, sapReview } from "~/db/schema";
import { audit } from "../audit.server";
import type { Db } from "../db.server";

// Keeps Setup Access Passes consistent when a camper's plans change. Kept apart from
// sap.server.ts so the RSVP and deactivation code can use it without an import cycle.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const coming = (intent: string | null) => intent === "going" || intent === "leaning_yes";

export async function releasePassesOf(tx: Tx, participationId: string) {
  return tx
    .update(sapPass)
    .set({ holderParticipationId: null, assignedByPersonId: null, assignedAt: null })
    .where(eq(sapPass.holderParticipationId, participationId))
    .returning({ serial: sapPass.serial });
}

// Records a pass released as a side effect, so the person's History shows it and who caused it.
async function logAutoRelease(
  tx: Tx,
  actorPersonId: string,
  personId: string,
  reason: "rsvp_changed" | "deactivated",
  serials: string[],
) {
  await audit(tx, {
    actorPersonId,
    action: "sap_pass_auto_released",
    subjectType: "person",
    subjectId: personId,
    after: { reason, serials },
  });
}

// Called when a camper's RSVP changes: if they're no longer coming, withdrew their request, or
// changed the day after a decision, their pass is released and the decision is flagged.
export async function onRsvpChanged(
  tx: Tx,
  actorPersonId: string,
  personId: string,
  participationId: string,
  before: { intent: string | null; sapRequested: boolean | null; sapDate: string | null } | null,
  after: { intent: string | null; sapRequested: boolean | null; sapDate: string | null },
) {
  const [review] = await tx
    .select({ id: sapReview.id })
    .from(sapReview)
    .where(eq(sapReview.participationId, participationId));
  if (!review) return;
  const changed =
    !coming(after.intent) ||
    after.sapRequested !== true ||
    (before !== null && before.sapDate !== after.sapDate);
  if (!changed) return;
  const released = await releasePassesOf(tx, participationId);
  await tx.update(sapReview).set({ flagged: true }).where(eq(sapReview.id, review.id));
  if (released.length) {
    await logAutoRelease(
      tx,
      actorPersonId,
      personId,
      "rsvp_changed",
      released.map((r) => r.serial),
    );
  }
}

// Releases every pass a person holds (used when they're deactivated), flagging the decision.
export async function releaseForPerson(tx: Tx, actorPersonId: string, personId: string) {
  const held = await tx.execute<{ participation_id: string }>(sql`
    select s.holder_participation_id as participation_id from sap_pass s
    join participation pa on pa.id = s.holder_participation_id
    where pa.person_id = ${personId}
  `);
  const serials: string[] = [];
  for (const h of held) {
    serials.push(...(await releasePassesOf(tx, h.participation_id)).map((r) => r.serial));
    await tx
      .update(sapReview)
      .set({ flagged: true })
      .where(eq(sapReview.participationId, h.participation_id));
  }
  if (serials.length) await logAutoRelease(tx, actorPersonId, personId, "deactivated", serials);
}
