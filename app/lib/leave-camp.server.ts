// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { data } from "react-router";
import { person } from "~/db/schema";
import type { Viewer } from "./access.server";
import { audit } from "./audit.server";
import { releaseForPerson } from "./data/sap-cascade.server";
import type { Db } from "./db.server";
import { deleteObject } from "./photos.server";
import { endCampSessions, lockActiveHolders } from "./roles.server";

// A member leaves this camp (R10): they're deactivated here, their photo is deleted, their
// Setup Access Pass (if any) is released, and their sessions at this camp end. Their login and
// their other camps are untouched, and a Lead can invite them back like anyone deactivated.
// The camp's last active Admin must hand that role on first (issue #93: Admin is the only role
// that needs a last holder, since an Admin can always do everything).
export async function leaveCamp(db: Db, env: { PHOTOS: R2Bucket }, viewer: Viewer) {
  let photoKey: string | null = null;
  await db.transaction(async (tx) => {
    const admins = await lockActiveHolders(tx, "admin");
    if (admins.includes(viewer.personId) && admins.length <= 1) {
      throw data({ reason: "leaving_last_admin" }, { status: 409 });
    }
    const [before] = await tx
      .select()
      .from(person)
      .where(eq(person.id, viewer.personId))
      .for("update");
    if (!before?.active) return;
    photoKey = before.photoKey;
    await tx
      .update(person)
      .set({ active: false, photoKey: null, photoUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(person.id, viewer.personId));
    await releaseForPerson(tx, viewer.personId, viewer.personId);
    if (before.authUserId) await endCampSessions(tx, before.authUserId);
    await audit(tx, {
      actorPersonId: viewer.personId,
      action: "person_left",
      subjectType: "person",
      subjectId: viewer.personId,
    });
  });
  // After the commit: the photo is only deleted once they've really left.
  await deleteObject(env, photoKey);
}
