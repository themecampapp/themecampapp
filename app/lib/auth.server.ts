// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import * as authSchema from "~/db/auth-schema";
import { isAllowlisted } from "./allowlist.server";
import { logAuthEvent } from "./auth-log.server";
import type { Db } from "./db.server";
import { sendMail } from "./mail.server";

export type AuthEnv = import("./mail.server").MailEnv & { BETTER_AUTH_SECRET: string };

// Built per request for the request's camp (the db handle acts for that camp only, and
// APP_URL is the camp's own origin). `defer` runs work after the response (ctx.waitUntil in
// production) so invited and uninvited requests take the same time.
//
// One login (user) per email across the platform, but everything else is per camp: the
// session records its camp (checked by resolveViewer), the cookie is host-only, and every
// magic-link token starts with the id of the camp that issued it (checked by the confirm page).
export function createAuth(
  db: Db,
  env: AuthEnv,
  defer: (p: Promise<unknown>) => void,
  campId: string,
) {
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    // Belt and braces: app/routes/api.auth.$.ts only lets get-session and sign-out through
    // over HTTP. Everything that spans the whole login (other camps' sessions, accounts) or
    // skips the confirm page's camp check is off here too.
    disabledPaths: [
      "/list-sessions",
      "/magic-link/verify",
      "/update-session",
      "/account-info",
      "/update-user",
      "/delete-user",
      "/change-email",
      "/change-password",
      "/set-password",
      "/list-accounts",
      "/link-social",
      "/unlink-account",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
    ],
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      defaultCookieAttributes: { sameSite: "lax", secure: true, httpOnly: true },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    // The session's camp: set when it's created, never from the client.
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      additionalFields: { campId: { type: "string", required: true, input: false } },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({ data: { ...session, campId } }),
        },
      },
      user: {
        create: {
          // Backstop: a login can only ever be created for an allowlisted email.
          before: async (user) => {
            if (!(await isAllowlisted(db, user.email))) return false;
            return { data: user };
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        storeToken: "hashed",
        // "<camp id>.<random>": the confirm page refuses a token issued by another camp.
        generateToken: () => `${campId}.${randomToken()}`,
        sendMagicLink: async ({ email, token }) => {
          // The emailed link opens our confirm page; a GET there never consumes the token.
          const url = new URL("/sign-in/confirm", env.APP_URL);
          url.searchParams.set("token", token);
          defer(
            (async () => {
              if (!(await isAllowlisted(db, email))) {
                await logAuthEvent(db, { event: "link_not_sent", email });
                return;
              }
              const sent = await sendMail(db, env, "magic_link", email, { url: url.toString() });
              await logAuthEvent(db, {
                event: sent === "sent" ? "link_sent" : "link_send_failed",
                email,
              });
            })(),
          );
        },
      }),
    ],
  });
}

// 32 random bytes, URL-safe.
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Whether a magic-link token was issued by this camp.
export const tokenIsForCamp = (token: string, campId: string) => token.startsWith(`${campId}.`);

export type Auth = ReturnType<typeof createAuth>;
