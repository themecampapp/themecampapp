// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Where each camp's files live in the private bucket (R4): camps/<camp id>/<kind>/<uuid>.<ext>.
// Keys are random, and every read builds or checks the key against the requesting camp before
// it touches the bucket (the database row lookup is the other half), so one camp can never be
// handed another's file, and deleting a camp can remove its whole prefix.

export type FileKind = "p" | "sap" | "logo" | "exports";
type Ext = "webp" | "pdf" | "zip";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAME_RE = new RegExp(`^${UUID}\\.(webp|pdf|zip)$`);
const KEY_RE = new RegExp(`^camps/(${UUID})/(p|sap|logo|exports)/${UUID}\\.(webp|pdf|zip)$`);

export const campPrefix = (campId: string) => `camps/${campId}/`;

export function newKey(campId: string, kind: FileKind, ext: Ext) {
  if (!new RegExp(`^${UUID}$`).test(campId)) throw new Error("newKey needs a camp id");
  return `${campPrefix(campId)}${kind}/${crypto.randomUUID()}.${ext}`;
}

// The last part of a key, as it appears in URLs (/photos/<name>).
export const fileName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

// The key for a file name taken from a URL, in this camp, or null for anything that isn't a
// plain "<uuid>.<ext>" (so no "..", slashes or other camps' prefixes).
export function keyFor(campId: string, kind: FileKind, name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const key = `${campPrefix(campId)}${kind}/${name}`;
  return KEY_RE.test(key) ? key : null;
}

// Whether a stored key is a well-formed key of this camp's, of this kind.
export function inCamp(campId: string, kind: FileKind, key: string | null | undefined) {
  const m = key ? KEY_RE.exec(key) : null;
  return !!m && m[1] === campId && m[2] === kind;
}
