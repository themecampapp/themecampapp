// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { data } from "react-router";
import { campSettings } from "~/db/schema";
import type { Viewer } from "./access.server";
import { audit } from "./audit.server";
import type { Db } from "./db.server";
import { newKey } from "./files.server";
import { deleteObject, sniffImage } from "./photos.server";

// The camp's logo (R19), set by its Admins. Like photos, an upload is identified by its bytes
// (never SVG, whose scripts would run), re-encoded by the Images binding to a WebP that fits
// 400x120 (transparency kept, metadata dropped), and stored under the camp's prefix.

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

type LogoEnv = { PHOTOS: R2Bucket; IMAGES: ImagesBinding };

const refuse = (reason: string, status = 400) => data({ reason }, { status });

function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin) throw data({ reason: "admin_only" }, { status: 403 });
}

export async function setLogo(
  db: Db,
  env: LogoEnv,
  campId: string,
  actor: Viewer,
  bytes: Uint8Array<ArrayBuffer>,
) {
  assertAdmin(actor);
  if (bytes.byteLength === 0) throw refuse("logo_missing");
  if (bytes.byteLength > MAX_LOGO_BYTES) throw refuse("logo_too_large");
  if (!sniffImage(bytes)) throw refuse("logo_bad_type");

  let webp: ArrayBuffer;
  try {
    const stream = new Response(bytes).body as ReadableStream<Uint8Array>;
    const result = await env.IMAGES.input(stream)
      .transform({ width: 400, height: 120, fit: "scale-down" })
      .output({ format: "image/webp", quality: 90 });
    webp = await result.response().arrayBuffer();
  } catch (e) {
    console.error(
      `logo transform failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`,
    );
    throw refuse("logo_processing_failed", 503);
  }

  const key = newKey(campId, "logo", "webp");
  await env.PHOTOS.put(key, webp, { httpMetadata: { contentType: "image/webp" } });
  let oldKey: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(campSettings).for("update");
      oldKey = before.logoKey;
      await tx
        .update(campSettings)
        .set({ logoKey: key, updatedAt: new Date() })
        .where(eq(campSettings.campId, before.campId));
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "camp_logo_saved",
        subjectType: "camp",
        subjectId: before.campId,
      });
    });
  } catch (e) {
    await deleteObject(env, key);
    throw e;
  }
  await deleteObject(env, oldKey);
}

export async function removeLogo(db: Db, env: LogoEnv, actor: Viewer) {
  assertAdmin(actor);
  let oldKey: string | null = null;
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(campSettings).for("update");
    oldKey = before.logoKey;
    if (!oldKey) return;
    await tx
      .update(campSettings)
      .set({ logoKey: null, updatedAt: new Date() })
      .where(eq(campSettings.campId, before.campId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "camp_logo_removed",
      subjectType: "camp",
      subjectId: before.campId,
    });
  });
  await deleteObject(env, oldKey);
}
