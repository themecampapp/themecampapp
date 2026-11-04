// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { platformHostKind } from "../../app/lib/hosts";
import { iconResponse } from "../../app/lib/icons";
import { featureOn } from "../../app/lib/instance-features";
import { withSecurityHeaders } from "../../app/lib/security-headers";
import { checkHealth } from "../app/jobs/health.server";
import { JOBS } from "../app/jobs/registry.server";
import { runJobs } from "../app/jobs/run.server";
import { verifyAccessJwt } from "../app/lib/access-jwt.server";
import { opsContext, publicContext, signupContext } from "../app/lib/context.server";
import { operatorFor } from "../app/lib/operator.server";
import { emailWebhook } from "../app/webhooks/email.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
const notFound = () => text("Not found", 404);
const forbidden = () => text("Forbidden", 403);

// The console's pages, plus what its client code fetches while navigating: route data
// ("/ops.data", "/ops/log.data") and React Router's route manifest ("/__manifest").
const isConsolePath = (path: string) =>
  path === "/ops" || path === "/ops.data" || path.startsWith("/ops/") || path === "/__manifest";

// The operator console (R38, R41): only on the ops. host, and only for a request that carries
// a Cloudflare Access token this Worker verifies itself, for an active operator. Anything
// else is a 403 with nothing else said.
async function ops(request: Request, env: PlatformEnv, ctx: ExecutionContext, url: URL) {
  if (url.pathname === "/") return Response.redirect(`https://${url.host}/ops`, 302);
  if (!isConsolePath(url.pathname) && !url.pathname.startsWith("/assets/")) return notFound();
  const email = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), {
    teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    aud: env.ACCESS_AUD ?? "",
  });
  if (!email) return forbidden();
  // Console changes only from the console's own pages: an exact Origin on every non-GET
  // request, even one without the header (React Router's own check skips those).
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (request.headers.get("Origin") !== `https://${url.host}`) return forbidden();
  }
  const sql = postgres(env.HYPERDRIVE_PLATFORM.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: true,
  });
  const pending: Promise<unknown>[] = [];
  try {
    const operator = await operatorFor(sql, email);
    if (!operator) return forbidden();
    const context = new RouterContextProvider();
    context.set(opsContext, {
      env,
      sql,
      operator,
      waitUntil: (p) => {
        pending.push(p);
      },
    });
    return await requestHandler(request, context);
  } finally {
    // Work handed off with waitUntil (emails) finishes before the connection closes.
    ctx.waitUntil(Promise.allSettled(pending).then(() => sql.end({ timeout: 5 })));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The instance's icon (open-source plan 3.5), on every host this Worker serves.
    const icon = iconResponse(env, url.pathname);
    if (icon) return withSecurityHeaders(icon);
    const kind = platformHostKind(url.hostname, env.PLATFORM_DOMAIN);
    // Issue #73: the link handed to camps, signup.<domain>, is the apex's sign-up page.
    // The sign-up page, on instances that have it (config features.signupPage, plan 3.7).
    const signupOn = featureOn(env, "signupPage");
    if (kind === "signup") {
      if (!signupOn) return withSecurityHeaders(notFound());
      return withSecurityHeaders(Response.redirect(`https://${env.PLATFORM_DOMAIN}/signup`, 302));
    }
    if (kind === "www") {
      const target = new URL(url.pathname + url.search, `https://${env.PLATFORM_DOMAIN}`);
      return withSecurityHeaders(Response.redirect(target.toString(), 301));
    }
    if (kind === "ops") {
      // An instance without the console (config features.console, open-source plan 3.3).
      if (env.CONSOLE !== "true") return withSecurityHeaders(notFound());
      // The console's "Open the camp" form posts to the camp's own host.
      return withSecurityHeaders(await ops(request, env, ctx, url), {
        formActions: [`https://*.${env.PLATFORM_DOMAIN}`],
      });
    }
    if (kind !== "public") return withSecurityHeaders(notFound());
    // The console's routes exist in the router, but never on the public host.
    if (
      url.pathname === "/ops" ||
      url.pathname === "/ops.data" ||
      url.pathname.startsWith("/ops/")
    ) {
      return withSecurityHeaders(notFound());
    }
    // Machine-to-machine, so it skips the app (and its Origin check): the webhook's bearer
    // secret is the authentication.
    const hook =
      url.pathname.match(/^\/webhooks\/email\/([a-z]+)(?:\/([a-z]+))?$/) ??
      // The old address of Plunk's workflows (open-source plan 3.1).
      url.pathname.match(/^\/webhooks\/(plunk)\/([a-z]+)$/);
    if (hook) return withSecurityHeaders(await emailWebhook(request, env, ctx, hook[1], hook[2]));
    const context = new RouterContextProvider();
    context.set(publicContext, {
      env,
      domain: env.PLATFORM_DOMAIN,
      product: env.PRODUCT_NAME,
      contact: env.CONTACT_EMAIL ?? `hello@${env.PLATFORM_DOMAIN}`,
      supportUrl: env.SUPPORT_URL || null,
      sourceUrl: env.SOURCE_URL || null,
    });
    // The sign-up page, and only it, gets a database connection (as app_platform).
    const signup =
      url.pathname === "/signup" ||
      url.pathname.startsWith("/signup/") ||
      url.pathname === "/signup.data";
    if (!signup) return withSecurityHeaders(await requestHandler(request, context));
    if (!signupOn) return withSecurityHeaders(notFound());
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (request.headers.get("Origin") !== `https://${url.host}`)
        return withSecurityHeaders(forbidden());
    }
    const sql = postgres(env.HYPERDRIVE_PLATFORM.connectionString, {
      max: 1,
      fetch_types: false,
      prepare: true,
    });
    try {
      context.set(signupContext, { env, sql, ip: request.headers.get("cf-connecting-ip") });
      return withSecurityHeaders(await requestHandler(request, context));
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },

  // Hourly (config crons.platform): the jobs in app/jobs/registry.server.ts, then
  // the health check.
  async scheduled(_controller, env, ctx) {
    const sql = postgres(env.HYPERDRIVE_PLATFORM.connectionString, {
      max: 1,
      fetch_types: false,
      prepare: true,
    });
    try {
      const results = await runJobs(sql, env, JOBS);
      // Last, so it can report any job that failed. It's a job too: its own failure is logged.
      await runJobs(sql, env, [
        {
          name: "health_check",
          run: (s, e) =>
            checkHealth(
              s,
              e,
              results.filter((r) => !r.ok),
            ),
        },
      ]);
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
} satisfies ExportedHandler<PlatformEnv>;
