// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Host names as the Workers route them. Requests arrive with any case, an optional port and
// an optional trailing dot; everything that compares hosts should go through normalizeHost.

export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  // Strip a port (hostnames here are never IPv6 literals).
  const colon = host.lastIndexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

// Hosts the platform Worker answers for, given its domain (the instance config's `domain`).
// Anything else, including every camp subdomain, is not the platform's.
export type PlatformHost = "public" | "www" | "ops" | "signup";

export function platformHostKind(rawHost: string, domain: string): PlatformHost | null {
  const host = normalizeHost(rawHost);
  const base = normalizeHost(domain);
  if (host === base) return "public";
  if (host === `www.${base}`) return "www";
  if (host === `ops.${base}`) return "ops";
  if (host === `signup.${base}`) return "signup";
  return null;
}

// A single-camp instance (config singleCamp, open-source plan 3.4): one camp, at its own host
// (the apex or any name under the domain), instead of <slug>.<domain>. Both Workers get it as
// SINGLE_CAMP_SLUG and SINGLE_CAMP_HOST, empty on a multi-camp instance.
export type SingleCampEnv = { SINGLE_CAMP_SLUG?: string; SINGLE_CAMP_HOST?: string };

export function singleCamp(env: SingleCampEnv): { slug: string; host: string } | null {
  return env.SINGLE_CAMP_SLUG && env.SINGLE_CAMP_HOST
    ? { slug: env.SINGLE_CAMP_SLUG, host: normalizeHost(env.SINGLE_CAMP_HOST) }
    : null;
}

// A camp's own origin, for links in emails and the console.
export function campOrigin(slug: string, domain: string, env: SingleCampEnv): string {
  const single = singleCamp(env);
  return single?.slug === slug ? `https://${single.host}` : `https://${slug}.${domain}`;
}

// Where the instance's legal pages are: the platform Worker's apex, or on a single-camp instance,
// which has no public site, the camp's own host (app/routes/legal.$doc.tsx).
export function legalBase(env: SingleCampEnv & { APP_HOST_SUFFIX: string }): string {
  const single = singleCamp(env);
  return `https://${single ? single.host : env.APP_HOST_SUFFIX}`;
}
