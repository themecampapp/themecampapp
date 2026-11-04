// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { operator } from "~/db/schema";
import { AUD, accessKeys, TEAM } from "../platform/access-keys";
import { APP_HOST_SUFFIX, INSTANCE } from "./context";
import type { TestDb } from "./db";
import { isSend, readSend, type SentEmail, sendResponse, TEST_EMAIL_ENV } from "./mail";
import { DISCORD_WEBHOOK } from "./worker";

// The platform Worker (its built bundle) in Miniflare, connected as app_platform to a test
// database, with an operator signed in through a stand-in for Cloudflare Access. Emails it
// sends through the email provider are captured in `mail`.

const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
export const OPS = `https://ops.${APP_HOST_SUFFIX}`;

export type PlatformMail = SentEmail;

// `bindings` overrides the test instance's settings (e.g. no SUPPORT_URL).
export async function startPlatform(
  t: TestDb,
  operatorEmail = "casey@example.com",
  bindings: Record<string, string> = {},
) {
  const keys = await accessKeys();
  await t.db.insert(operator).values({ email: operatorEmail, name: "Casey" });
  const token = await keys.token(operatorEmail);
  const mail: PlatformMail[] = [];
  const discord: string[] = [];
  // What Cloudflare's Turnstile siteverify answers for the sign-up page; tests can change it.
  const turnstile = { success: true, hostname: APP_HOST_SUFFIX, action: "signup" };

  const files = (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(ROOT, f));
  files.sort((a, b) => Number(b.endsWith("/index.js")) - Number(a.endsWith("/index.js")));
  const url = new URL(t.runtimeUrl);
  url.username = "app_platform";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: files.map((path) => ({ type: "ESModule" as const, path, contents: undefined })),
      modulesRoot: ROOT,
      compatibilityDate: "2026-09-23",
      compatibilityFlags: ["nodejs_compat"],
      hyperdrives: { HYPERDRIVE_PLATFORM: url.toString() },
      r2Buckets: ["FILES"],
      bindings: {
        PLATFORM_DOMAIN: APP_HOST_SUFFIX,
        ALERT_MAIL_FROM: "notify@mail.themecamp.test",
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: AUD,
        CONSOLE: "true",
        ...TEST_EMAIL_ENV,
        OPERATOR_EMAIL: "operator@example.com",
        DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK,
        TURNSTILE_SITE_KEY: "site-key-test",
        TURNSTILE_SECRET: "turnstile-test-secret",
        ...INSTANCE,
        RESERVED_SLUGS: "themecamp,theme-camp,themecampapp,tca",
        RESERVED_PARTS: "themecampapp,theme-camp-app",
        ...bindings,
      },
      ratelimits: { SIGNUP_LIMITER: { namespace_id: "1003", simple: { limit: 5, period: 60 } } },
      outboundService: async (req) => {
        const u = new URL(req.url);
        if (`${u.origin}${u.pathname}` === `${TEAM}/cdn-cgi/access/certs`)
          return Response.json(keys.jwks);
        if (req.url === DISCORD_WEBHOOK) {
          // Only messages that can't ping anyone are accepted (and recorded).
          const m = (await req.json()) as { content: string; allowed_mentions?: { parse?: [] } };
          if (m.allowed_mentions?.parse?.length !== 0)
            return new Response("mentions", { status: 400 });
          discord.push(m.content);
          return new Response(null, { status: 204 });
        }
        if (u.hostname === "challenges.cloudflare.com") return Response.json(turnstile);
        if (isSend(req.url)) {
          mail.push(readSend(req.url, await req.text()) as SentEmail);
          return sendResponse("e1");
        }
        return new Response("blocked in tests", { status: 599 });
      },
    }),
  );
  await mf.ready;

  // A console page, as the signed-in operator sees it.
  const consoleGet = (path: string) =>
    mf.dispatchFetch(`${OPS}${path}`, {
      redirect: "manual",
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
  // A console form, posted from the console's own origin.
  const consolePost = (path: string, fields: Record<string, string>) =>
    mf.dispatchFetch(`${OPS}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        origin: OPS,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    });
  // The public site (the apex), as a visitor sees it: pages, and forms posted from it.
  // Each post comes from its own address unless one is given (the sign-up limit is per IP).
  let n = 0;
  const site = (path: string, fields?: Record<string, string>, ip = `203.0.113.${++n % 250}`) =>
    mf.dispatchFetch(`https://${APP_HOST_SUFFIX}${path}`, {
      redirect: "manual",
      ...(fields
        ? {
            method: "POST",
            headers: {
              origin: `https://${APP_HOST_SUFFIX}`,
              "content-type": "application/x-www-form-urlencoded",
              "cf-connecting-ip": ip,
            },
            body: new URLSearchParams(fields).toString(),
          }
        : {}),
    });
  return {
    mf,
    mail,
    discord,
    turnstile,
    site,
    consoleGet,
    consolePost,
    dispose: () => mf.dispose(),
  };
}
