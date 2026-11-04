// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache, verifyAccessJwt } from "../../platform/app/lib/access-jwt.server";
import { AUD, accessKeys, TEAM } from "./access-keys";

// R41: the console trusts only a Cloudflare Access token it verified itself.

let keys: Awaited<ReturnType<typeof accessKeys>>;
let other: Awaited<ReturnType<typeof accessKeys>>;
const config = { teamDomain: TEAM, aud: AUD };

beforeAll(async () => {
  keys = await accessKeys();
  other = await accessKeys(); // same kid, different key
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessKeyCache();
});

function serveKeys(jwks: unknown) {
  const fetchMock = vi.fn(async (url: string) =>
    url === `${TEAM}/cdn-cgi/access/certs`
      ? Response.json(jwks)
      : new Response("no", { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns its email, lowercased", async () => {
    serveKeys(keys.jwks);
    expect(await verifyAccessJwt(await keys.token("Casey@Example.com"), config)).toBe(
      "casey@example.com",
    );
  });

  it("caches the keys", async () => {
    const fetchMock = serveKeys(keys.jwks);
    await verifyAccessJwt(await keys.token("a@example.com"), config);
    await verifyAccessJwt(await keys.token("a@example.com"), config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no token", async () => null],
    ["garbage", async () => "not.a.jwt"],
    ["the wrong audience", async () => keys.token("a@example.com", { aud: ["someone-else"] })],
    [
      "the wrong issuer",
      async () => keys.token("a@example.com", { iss: "https://evil.cloudflareaccess.com" }),
    ],
    [
      "an expired token",
      async () => keys.token("a@example.com", { exp: Math.floor(Date.now() / 1000) - 5 }),
    ],
    ["no expiry", async () => keys.token("a@example.com", { exp: undefined })],
    ["no email", async () => keys.token("", {})],
    ["a signature from another key", async () => other.token("a@example.com")],
    [
      "an unknown key id",
      async () =>
        keys.sign({ aud: [AUD], iss: TEAM, email: "a@example.com", exp: 9e9 }, { kid: "nope" }),
    ],
    [
      "alg none",
      async () =>
        keys.sign({ aud: [AUD], iss: TEAM, email: "a@example.com", exp: 9e9 }, { alg: "none" }),
    ],
    [
      "HS256",
      async () =>
        keys.sign({ aud: [AUD], iss: TEAM, email: "a@example.com", exp: 9e9 }, { alg: "HS256" }),
    ],
  ])("refuses %s", async (_name, make) => {
    serveKeys(keys.jwks);
    expect(await verifyAccessJwt(await make(), config)).toBeNull();
  });

  it("refuses everything when Access isn't configured", async () => {
    serveKeys(keys.jwks);
    const token = await keys.token("a@example.com");
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: "" })).toBeNull();
    expect(await verifyAccessJwt(token, { teamDomain: "", aud: AUD })).toBeNull();
  });

  it("refuses a token whose payload was edited after signing", async () => {
    serveKeys(keys.jwks);
    const [h, , s] = (await keys.token("a@example.com")).split(".");
    const forged = btoa(
      JSON.stringify({ aud: [AUD], iss: TEAM, email: "evil@example.com", exp: 9e9 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyAccessJwt(`${h}.${forged}.${s}`, config)).toBeNull();
  });
});
