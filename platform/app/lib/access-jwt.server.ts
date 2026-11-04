// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloudflare Access puts a signed JWT on every request it lets through to the console
// (Cf-Access-Jwt-Assertion). The Worker checks it itself, so a mistake in the Access setup
// can't open the console: RS256 signature against the team's published keys, the
// application's audience tag, the team as issuer, and expiry. The email claim then has to be
// an active operator (operator.server.ts).

export type AccessConfig = {
  teamDomain: string; // https://<team>.cloudflareaccess.com
  aud: string; // the Access application's audience tag
};

type Jwk = JsonWebKey & { kid?: string };
type Claims = { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { keys: Jwk[]; at: number }>();

async function keys(teamDomain: string, fresh = false): Promise<Jwk[]> {
  const hit = cache.get(teamDomain);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const found = body.keys ?? [];
  cache.set(teamDomain, { keys: found, at: Date.now() });
  return found;
}

const b64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

// The verified email, lowercased, or null for anything not exactly right.
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  now = Date.now(),
): Promise<string | null> {
  if (!token || !config.teamDomain.startsWith("https://") || !config.aud) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = json(parts[0]);
    claims = json(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let jwk = (await keys(config.teamDomain)).find((k) => k.kid === header.kid);
  // Access rotates its keys; an unknown kid is worth one fresh fetch.
  if (!jwk) jwk = (await keys(config.teamDomain, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(config.aud)) return null;
  if (claims.iss !== config.teamDomain) return null;
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return null;
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return null;
  return claims.email.trim().toLowerCase();
}

// For tests only: forget cached keys.
export function clearAccessKeyCache() {
  cache.clear();
}
