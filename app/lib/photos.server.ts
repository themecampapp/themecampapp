// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { person } from "~/db/schema";
import { can, type Viewer } from "./access.server";
import { audit } from "./audit.server";
import type { Db } from "./db.server";
import { newKey } from "./files.server";
import { sendMail } from "./mail.server";
import { hitRateLimit } from "./rate-limit.server";

// Profile photos for the Yearbook. Uploads are identified by their bytes (never the filename
// or browser-supplied type), re-encoded by the Images binding to a 512x512 WebP (which drops
// all EXIF/GPS metadata), and stored under a random key in a private R2 bucket. Only the
// processed image is ever stored.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type PhotoEnv = { PHOTOS: R2Bucket; IMAGES: ImagesBinding } & import("./mail.server").MailEnv;

const refuse = (reason: string, status = 400) => data({ reason }, { status });

// JPEG, PNG, WebP or HEIC/HEIF by magic bytes; anything else (SVG, GIF, text…) is refused.
export function sniffImage(bytes: Uint8Array): "jpeg" | "png" | "webp" | "heic" | null {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(4, "ftyp") && ["heic", "heix", "mif1", "heif", "hevc", "msf1"].some((b) => ascii(8, b)))
    return "heic";
  return null;
}

export async function deleteObject(env: { PHOTOS: R2Bucket }, key: string | null) {
  if (!key) return;
  try {
    await env.PHOTOS.delete(key);
  } catch (e) {
    console.error(`photo cleanup failed: ${e instanceof Error ? e.name : "error"}`);
  }
}

// Validates, transforms and stores a new photo, then swaps it in and deletes the old one.
export async function setPhoto(
  db: Db,
  env: PhotoEnv,
  campId: string,
  personId: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  if (bytes.byteLength === 0) throw refuse("photo_missing");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw refuse("photo_too_large");
  if (!sniffImage(bytes)) throw refuse("photo_bad_type");
  if (!(await hitRateLimit(db, `photo:${personId}`, { windowSeconds: 86400, max: 10 }))) {
    throw refuse("photo_rate_limited", 429);
  }

  let webp: ArrayBuffer;
  try {
    const stream = new Response(bytes).body as ReadableStream<Uint8Array>;
    const result = await env.IMAGES.input(stream)
      .transform({ width: 512, height: 512, fit: "cover", gravity: "auto" })
      .output({ format: "image/webp", quality: 82 });
    // R2 needs a known length, so buffer the (small) result before storing.
    webp = await result.response().arrayBuffer();
  } catch (e) {
    console.error(
      `photo transform failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`,
    );
    throw refuse("photo_processing_failed", 503);
  }

  const key = newKey(campId, "p", "webp");
  await env.PHOTOS.put(key, webp, { httpMetadata: { contentType: "image/webp" } });

  let oldKey: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ key: person.photoKey })
        .from(person)
        .where(eq(person.id, personId))
        .for("update");
      oldKey = before?.key ?? null;
      await tx
        .update(person)
        .set({ photoKey: key, photoUpdatedAt: new Date(), updatedAt: new Date() })
        .where(eq(person.id, personId));
      await audit(tx, {
        actorPersonId: personId,
        action: "photo_updated",
        subjectType: "person",
        subjectId: personId,
      });
    });
  } catch (e) {
    await deleteObject(env, key);
    throw e;
  }
  await deleteObject(env, oldKey);
}

// Removes someone's photo (stored object included). A Lead removing another person's photo
// is audited and the person is told by email.
export async function removePhoto(
  db: Db,
  env: PhotoEnv,
  actor: { personId: string },
  personId: string,
  opts: { notify?: boolean } = {},
) {
  let oldKey: string | null = null;
  let email: string | null = null;
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ key: person.photoKey, email: person.email })
      .from(person)
      .where(eq(person.id, personId))
      .for("update");
    oldKey = before?.key ?? null;
    email = before?.email ?? null;
    if (!oldKey) return;
    await tx
      .update(person)
      .set({ photoKey: null, photoUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(person.id, personId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: actor.personId === personId ? "photo_removed" : "photo_removed_by_lead",
      subjectType: "person",
      subjectId: personId,
    });
  });
  if (!oldKey) return;
  await deleteObject(env, oldKey);
  if (opts.notify && email && actor.personId !== personId) {
    await sendMail(db, env, "photo_removed", email, {
      url: new URL("/profile", env.APP_URL).toString(),
    });
  }
}

// Who may load a given photo: its owner, anyone who can see People, or any member while the owner is in a
// Yearbook: this year's (active and Going/Leaning yes) or a past one (active and camped in
// an earlier season). Everyone else gets a 404.
export async function photoVisibleTo(db: Db, viewer: Viewer, key: string): Promise<boolean> {
  const rows = await db.execute<{ id: string; in_yearbook: boolean }>(sql`
    select p.id,
      (p.active and exists (
        select 1 from participation pa join burn b on b.id = pa.burn_id
        where pa.person_id = p.id and (
          (b.year = current_year() and pa.intent in ('going', 'leaning_yes'))
          or (b.year < current_year() and pa.attended)
        )
      )) as in_yearbook
    from person p where p.photo_key = ${key}
  `);
  const owner = rows[0];
  if (!owner) return false;
  return owner.id === viewer.personId || can(viewer, "people") || owner.in_yearbook;
}

export type YearbookCard = {
  personId: string; // server-side only: used to look up camp years, never sent to the page
  key: string;
  label: string;
  secondary: string | null;
  homeLocation: string | null;
};

// This year's Yearbook: active campers who are Going or Leaning yes and have a photo.
// Label is the playa name; the legal first name appears only if they opted in, or as the
// label when there's no playa name (which the profile preview shows before upload).
export function cardLabel(p: {
  playaName: string | null;
  legalName: string;
  showFirstName: boolean;
}) {
  const first = p.legalName.trim().split(/\s+/)[0];
  if (!p.playaName) return { label: first, secondary: null };
  return { label: p.playaName, secondary: p.showFirstName ? first : null };
}

export async function yearbook(db: Db): Promise<YearbookCard[]> {
  const rows = await db.execute<{
    id: string;
    key: string;
    home_location: string | null;
    playa_name: string | null;
    legal_name: string;
    show: boolean;
  }>(sql`
    select p.id, p.photo_key as key, p.home_location, p.playa_name, p.legal_name, p.yearbook_show_first_name as show
    from person p
    join participation pa on pa.person_id = p.id
    join burn b on b.id = pa.burn_id and b.year = current_year()
    where p.active and p.photo_key is not null and pa.intent in ('going', 'leaning_yes')
    order by lower(coalesce(p.playa_name, p.legal_name))
  `);
  return rows.map((r) => ({
    personId: r.id,
    key: r.key,
    homeLocation: r.home_location,
    ...cardLabel({ playaName: r.playa_name, legalName: r.legal_name, showFirstName: r.show }),
  }));
}

export async function setShowFirstName(db: Db, personId: string, show: boolean) {
  await db
    .update(person)
    .set({ yearbookShowFirstName: show, updatedAt: new Date() })
    .where(and(eq(person.id, personId)));
}
