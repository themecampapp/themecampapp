// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// R13: camp slugs (the `<slug>.<domain>` address). Lowercase letters, digits and inner hyphens,
// 2 to 40 characters (the database's camp_slug_ck allows 1; a one-letter camp name is too easy
// to mistake). System names and names that could pass for Burning Man Project are reserved
// here; names that could pass for the instance itself come from its config (product.reserved
// Slugs and reservedParts, open-source plan 2.4).

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$/;

const RESERVED = new Set([
  // Platform and system hosts.
  "www",
  "app",
  "api",
  "admin",
  "ops",
  "console",
  "operator",
  "support",
  "help",
  "status",
  "docs",
  "blog",
  "about",
  "legal",
  "privacy",
  "terms",
  "security",
  "abuse",
  "demo",
  "sandbox",
  "staging",
  "dev",
  "test",
  "preview",
  "static",
  "assets",
  "cdn",
  "files",
  "images",
  "img",
  "auth",
  "login",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "account",
  "accounts",
  "billing",
  "webhooks",
  "platform",
  "root",
  "system",
  // Mail and DNS.
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "webmail",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "ftp",
  "postmaster",
  "hostmaster",
  "webmaster",
  "notify",
  "bounce",
  // Burning Man Project and the event.
  "bm",
  "bmp",
  "bmorg",
  "burn",
  "burner",
  "burners",
  "playa",
  "blackrock",
  "black-rock",
  "brc",
  "blackrockcity",
  "black-rock-city",
  "rangers",
  "dpw",
  "placement",
  "stewards",
  "tickets",
]);

// Look-alikes anywhere in the name.
const RESERVED_PARTS = ["burningman", "burning-man"];

export type SlugProblem = "slug_format" | "slug_reserved";
export type InstanceReserved = { slugs: string[]; parts: string[] };

// The instance's own reserved names, from its config (the platform Worker's RESERVED_SLUGS and
// RESERVED_PARTS vars, comma-separated).
export const instanceReserved = (env: { RESERVED_SLUGS?: string; RESERVED_PARTS?: string }) => {
  const list = (v?: string) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return { slugs: list(env.RESERVED_SLUGS), parts: list(env.RESERVED_PARTS) };
};

// Why this slug can't be used (not whether it's taken: that's the database's unique index).
export function slugProblem(
  slug: string,
  instance: InstanceReserved = { slugs: [], parts: [] },
): SlugProblem | null {
  if (!SLUG_RE.test(slug) || slug.includes("--")) return "slug_format";
  if (RESERVED.has(slug) || instance.slugs.includes(slug)) return "slug_reserved";
  if ([...RESERVED_PARTS, ...instance.parts].some((p) => slug.includes(p))) return "slug_reserved";
  return null;
}
