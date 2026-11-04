// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// An instance's settings (open-source plan, Unit 2.1): everything that differs between the
// hosted service, its staging copy and a self-hosted instance, except secrets. Secrets stay in
// Worker secrets and GitHub environments; nothing here is a credential. Hyperdrive ids,
// Turnstile site keys and the Access audience are identifiers, designed to be public.
//
// One file per instance in config/: hosted.json (themecamp.app), staging.json (themecamp.dev),
// local.json (development and tests) and example.json (the template for self-hosters).
// scripts/config-to-wrangler.ts turns them into the two Workers' Wrangler configs.

export type InstanceConfig = {
  // The Wrangler environment this instance deploys as ("staging"), or null for the top level.
  wranglerEnv: string | null;
  // The apex domain. Camps are <slug>.<domain>; the platform Worker serves the apex, www, ops
  // and signup.
  domain: string;
  workers: { camps: string; platform: string };
  // Hyperdrive config ids, one per Worker (each connects as its own database role).
  hyperdrive: { camps: string; platform: string };
  // The private R2 bucket for camp files.
  bucket: string;
  // Where both Workers run: next to the database (targeted placement).
  placementRegion: string;
  // Rate-limit namespace ids (account-wide numbers): the join form and the sign-up form.
  rateLimits: { join: string; signup: string };
  // Turnstile site keys: the camps' join pages, and the public sign-up page.
  turnstile: { camps: string; signup: string };
  // The Cloudflare Access application in front of the console, or null for none (the console
  // then refuses everyone).
  access: { teamDomain: string; aud: string } | null;
  crons: { camps: string; platform: string };
  mail: {
    provider: "plunk" | "postmark";
    from: string; // camp mail
    authFrom: string; // sign-in links and email changes
    alertFrom: string; // the operator's alerts and console emails
    // Staging: mail goes only to the MAIL_ALLOWLIST Worker secret, and to nobody while that
    // secret is missing, so a staging copy can never email a real camper.
    restricted: boolean;
  };
  // Who runs the instance and what it's called (used from Unit 2.4 on).
  product: {
    name: string;
    operator: string;
    contactEmail: string; // the contact and abuse address; must receive mail
    // Where camps get help (the hosted service's Discord), or null for none: then the app's
    // "join the community" links don't appear.
    supportUrl: string | null;
    // Where the instance's source code is, linked from every page. The AGPL (section 13) has an
    // instance offer its source to the people who use it, so this is required: the public
    // repository for an unmodified instance, or your own fork's address once you've changed the
    // code.
    sourceUrl: string;
    // Camp addresses that could pass for this instance itself: exact slugs, and parts that
    // can't appear anywhere in one (on top of the app's general list in reserved-slugs.ts).
    reservedSlugs: string[];
    reservedParts: string[];
    // Its favicon and apple-touch icon: a folder under icons/ (hosted is the TCA icon, default a
    // neutral one; scripts/make-icon.ts draws one from initials).
    icon: string;
  };
  // Hosted-only pieces each instance turns on or off (Units 3.3 and 3.7; what each does is in
  // app/lib/instance-features.ts). The legal templates mention a feature only when it's on.
  features: {
    signupPage: boolean;
    console: boolean;
    feedback: boolean;
    usage: boolean;
    discord: boolean;
  };
  // Its legal pages (Unit 3.6): the folder under legal/ they're in (the hosted service's own are
  // legal/hosted; legal/templates are examples for self-hosters), and whether new camps' Admins
  // must accept the pilot agreement (legal/<dir>/pilot-agreement.md) before using the app.
  legal: { dir: string; pilotAgreement: boolean };
  // One camp at its own host instead of <slug>.<domain> (Unit 3.4), or null for many camps. The
  // host is the domain itself or a name under it. The platform Worker then has no routes, just
  // its hourly jobs, so the console and the sign-up page must be off.
  singleCamp: { slug: string; host: string } | null;
  // How a deploy saves the database before migrating (Unit 3.2): a Neon branch (needs
  // NEON_API_KEY and NEON_PROJECT_ID), an age-encrypted pg_dump kept as a workflow artifact (any
  // Postgres; needs AGE_PUBLIC_KEY), or none (an instance with nothing to lose, like staging).
  database: { snapshot: "neon" | "dump" | "none" };
};

type Check = (value: unknown) => string | null;

const str: Check = (v) => (typeof v === "string" && v.trim() !== "" ? null : "a non-empty string");
const strOrNull: Check = (v) => (v === null ? null : str(v));
const bool: Check = (v) => (typeof v === "boolean" ? null : "true or false");
const oneOf =
  (...allowed: string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v) ? null : `one of ${allowed.join(", ")}`;
const email: Check = (v) =>
  typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "an email address";
const slugList: Check = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && /^[a-z0-9-]+$/.test(s))
    ? null
    : "a list of lowercase slugs";
const oneSlug: Check = (v) =>
  typeof v === "string" && /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(v) ? null : "a camp slug";
const folder: Check = (v) =>
  typeof v === "string" && /^[a-z0-9-]+$/.test(v) ? null : "a folder name under legal/";
const iconFolder: Check = (v) =>
  typeof v === "string" && /^[a-z0-9-]+$/.test(v) ? null : "a folder name under icons/";
const httpsUrl: Check = (v) =>
  typeof v === "string" && /^https:\/\/[^\s/]+\.[^\s]+$/.test(v) ? null : "an https:// address";
const domain: Check = (v) =>
  typeof v === "string" && /^[a-z0-9.-]+$/.test(v) && !v.startsWith(".") ? null : "a domain name";

// The shape, field by field. Nested objects are checked recursively; `null` allowed only where
// the type says so.
type Shape = { [key: string]: Check | Shape | { nullable: Shape } };
const SHAPE: Shape = {
  wranglerEnv: strOrNull,
  domain,
  workers: { camps: str, platform: str },
  hyperdrive: { camps: str, platform: str },
  bucket: str,
  placementRegion: str,
  rateLimits: { join: str, signup: str },
  turnstile: { camps: str, signup: str },
  access: { nullable: { teamDomain: str, aud: str } },
  crons: { camps: str, platform: str },
  mail: {
    provider: oneOf("plunk", "postmark"),
    from: email,
    authFrom: email,
    alertFrom: email,
    restricted: bool,
  },
  product: {
    name: str,
    operator: str,
    contactEmail: email,
    supportUrl: strOrNull,
    sourceUrl: httpsUrl,
    reservedSlugs: slugList,
    reservedParts: slugList,
    icon: iconFolder,
  },
  features: { signupPage: bool, console: bool, feedback: bool, usage: bool, discord: bool },
  legal: { dir: folder, pilotAgreement: bool },
  singleCamp: { nullable: { slug: oneSlug, host: domain } },
  database: { snapshot: oneOf("neon", "dump", "none") },
};

function problems(value: unknown, shape: Shape, path: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path || "the config"} must be an object`];
  }
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, check] of Object.entries(shape)) {
    const at = path ? `${path}.${key}` : key;
    if (!(key in record)) {
      out.push(`${at} is missing`);
      continue;
    }
    const v = record[key];
    if (typeof check === "function") {
      const wrong = check(v);
      if (wrong) out.push(`${at} must be ${wrong}`);
    } else if ("nullable" in check && Object.keys(check).length === 1) {
      if (v !== null) out.push(...problems(v, check.nullable as Shape, at));
    } else {
      out.push(...problems(v, check as Shape, at));
    }
  }
  for (const key of Object.keys(record)) {
    if (!(key in shape) && key !== "$comment")
      out.push(`${path ? `${path}.` : ""}${key} isn't a setting`);
  }
  return out;
}

// The config, checked: throws with every problem listed, so a bad file fails the build.
export function validateConfig(raw: unknown, source = "config"): InstanceConfig {
  const found = problems(raw, SHAPE, "");
  // Sign-ups are decided in the console, so the page needs it.
  const features = (raw as { features?: { signupPage?: unknown; console?: unknown } })?.features;
  if (features?.signupPage === true && features.console === false) {
    found.push("features.signupPage needs features.console: sign-ups are decided there");
  }
  const { singleCamp: single, domain: apex } = raw as { singleCamp?: unknown; domain?: unknown };
  if (single && typeof single === "object" && typeof apex === "string") {
    const host = (single as { host?: unknown }).host;
    if (typeof host === "string" && host !== apex && !host.endsWith(`.${apex}`)) {
      found.push("singleCamp.host must be the domain or a name under it");
    }
    if (features?.console !== false || features?.signupPage !== false) {
      found.push("singleCamp needs features.console and features.signupPage off");
    }
  }
  if (found.length) throw new Error(`${source}:\n  ${found.join("\n  ")}`);
  return raw as InstanceConfig;
}
