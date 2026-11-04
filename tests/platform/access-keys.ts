// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// A stand-in for Cloudflare Access in tests: an RSA key pair, its JWKS, and signed tokens.
export const TEAM = "https://test-team.cloudflareaccess.com";
export const AUD = "test-audience-tag";

const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function accessKeys(kid = "test-kid") {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwks = { keys: [{ kty: pub.kty, n: pub.n, e: pub.e, kid, alg: "RS256", use: "sig" }] };
  async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
    const p = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
      ),
    );
    return `${h}.${p}.${b64url(sig)}`;
  }
  const token = (email: string, overrides: Record<string, unknown> = {}) =>
    sign({
      aud: [AUD],
      iss: TEAM,
      email,
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      ...overrides,
    });
  return { jwks, sign, token };
}
