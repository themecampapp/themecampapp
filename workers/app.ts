// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequestHandler, RouterContextProvider } from "react-router";
import { readCapped } from "../app/lib/body-limit";
import {
  type CloudflareContext,
  cloudflareContext,
  finishRequest,
} from "../app/lib/context.server";
import { runDaily } from "../app/lib/daily.server";
import { createClients, endClients } from "../app/lib/db.server";
import { iconResponse } from "../app/lib/icons";
import { featureOn } from "../app/lib/instance-features";
import { withSecurityHeaders } from "../app/lib/security-headers";
import { campSlugForHost, lookupCamp } from "../app/lib/tenancy.server";
import {
  clientErrorMetric,
  type RouteMatch,
  recordUsage,
  responseMetrics,
  routeMatcher,
} from "../app/lib/usage.server";

const serverBuild = () => import("virtual:react-router/server-build");
const requestHandler = createRequestHandler(serverBuild, import.meta.env.MODE);

// R74: which route a request was for, by the build's route ids (built once per isolate).
let matcher: ((pathname: string) => RouteMatch | null) | undefined;
const matchRoute = async (pathname: string) => {
  matcher ??= routeMatcher(await serverBuild());
  return matcher(pathname);
};

// The browser's error beacon (app/components/ErrorBeacon.tsx) posts here; it isn't a page.
const CLIENT_ERROR_PATH = "/__usage/client-error";

// The same response for every host that isn't a camp: an unknown slug looks exactly like any
// other unknown host, so nobody can probe which camps exist. That's also why it never repeats
// the name that was typed or suggests a camp with a similar one. Issue #97: it reads as a
// friendly page, since a mistyped camp address (yellowbaloon.…) is the usual way here.
// `product` is the instance's name (config, open-source plan 3.5); escaped though it's ours.
const escapeHtml = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const notFound = (suffix: string, product: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Camp not found</title></head><body style="font-family:system-ui,sans-serif;background:#fbf8f2;color:#1a1714;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">We couldn't find that camp</h1><p>Check the camp's name in the address bar: it's the part just before <strong>.${suffix}</strong>, and it has to be spelled exactly as your camp set it up.</p><p>The easiest fix is the link your camp's organizers sent you. If you can't find it, ask one of them for it.</p><p><a href="https://${suffix}/" style="color:inherit">Go to ${escapeHtml(product)}</a></p></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Signing in and out keep working for a suspended camp; every other write is refused. Matches
// a listed path or anything below it, never a longer name that merely starts the same way.
const SUSPENDED_WRITES_ALLOWED = [
  "/confirm/request",
  "/sign-in",
  "/sign-out",
  "/api/auth",
  "/support/enter",
  "/support/leave",
];
const suspendedWriteAllowed = (path: string) =>
  SUSPENDED_WRITES_ALLOWED.some((p) => path === p || path.startsWith(`${p}/`));

// R67: a plain form post on the demo camp. (A page's own client-side post, "<path>.data", is
// refused by the app's root middleware instead, so it can show the same message in the page.)
const demoReadOnly = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Saving is off in the demo</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">Saving is off in the demo</h1><p>This is a demo camp with made-up people, so nothing you change is saved. Everything else works the way it would for your camp.</p><p><a href="/">Back to the demo</a></p></body></html>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

// The demo camp's file bucket: reads work, writes throw (no upload path should get this far).
const readOnlyBucket = (bucket: R2Bucket): R2Bucket =>
  new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "put" || prop === "delete" || prop === "createMultipartUpload") {
        return () => Promise.reject(new Error("the demo camp stores no files"));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

// The biggest write the app takes is a 5 MB photo or PDF, in a form. Anything larger is refused
// before its body is read, so an oversized upload can't use up the Worker's memory. A body that
// doesn't declare its size is read up to the limit and refused the moment it passes it.
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const tooLarge = () =>
  new Response("That's too big to upload.", {
    status: 413,
    headers: { "Content-Type": "text/plain" },
  });

// Support access (R39) is read-only for the pilot: a request carrying the support cookie may
// only enter or leave support, never change anything, whatever the route would allow.
const SUPPORT_COOKIE_RE = /(?:^|;\s*)__Secure-support=[^;]+/;
const SUPPORT_WRITES_ALLOWED = new Set(["/support/enter", "/support/leave"]);
const supportReadOnly = () =>
  new Response("Support access is read-only.", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });

const suspended = () =>
  new Response(
    "This camp is suspended, so changes are turned off. Contact your camp's organizers.",
    { status: 403, headers: { "Content-Type": "text/plain" } },
  );

export default {
  async fetch(incoming, env, ctx) {
    let request: Request = incoming;
    const url = new URL(request.url);
    // The instance's icon, on any host, before the camp lookup (open-source plan 3.5).
    const icon = iconResponse(env, url.pathname);
    if (icon) return withSecurityHeaders(icon);
    const slug = campSlugForHost(url.host, env);
    if (!slug) return withSecurityHeaders(notFound(env.APP_HOST_SUFFIX, env.PRODUCT_NAME));

    // All camp subdomains are the same site to the browser, so SameSite cookies don't stop one
    // camp's pages posting to another's. Every write must come from this exact origin, on page
    // actions, resource routes and /api/auth alike. A missing Origin is refused too.
    // The one exception: the operator console (ops.<domain>) posts the support token to
    // /support/enter, and only there.
    const origin = request.headers.get("Origin");
    // The route a write is for. React Router's client-side form posts go to "<path>.data" (a
    // Form on /x posts to /x.data), so the allowances below match on the path without it.
    const route = url.pathname.replace(/\.data$/, "");
    const fromConsole =
      url.pathname === "/support/enter" && origin === `https://ops.${env.APP_HOST_SUFFIX}`;
    if (!SAFE_METHODS.has(request.method) && origin !== url.origin && !fromConsole) {
      return withSecurityHeaders(new Response("Forbidden", { status: 403 }));
    }
    if (!SAFE_METHODS.has(request.method) && request.body) {
      const declared = request.headers.get("Content-Length");
      if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
        return withSecurityHeaders(tooLarge());
      }
      if (declared === null) {
        const body = await readCapped(request.body, MAX_BODY_BYTES);
        if (!body) return withSecurityHeaders(tooLarge());
        request = new Request(request, { body });
      }
    }
    if (
      !SAFE_METHODS.has(request.method) &&
      SUPPORT_COOKIE_RE.test(request.headers.get("Cookie") ?? "") &&
      !SUPPORT_WRITES_ALLOWED.has(route)
    ) {
      return withSecurityHeaders(supportReadOnly());
    }

    const clients = createClients(env.HYPERDRIVE.connectionString);
    const cf: Partial<CloudflareContext> = {
      ctx,
      deferred: [],
      cleanup: [() => endClients(clients)],
    };
    try {
      const camp = await lookupCamp(clients.pool, slug);
      if (!camp) return withSecurityHeaders(notFound(env.APP_HOST_SUFFIX, env.PRODUCT_NAME));
      // The demo camp never saves anything (its database transactions are read-only too).
      if (
        camp.kind === "demo" &&
        !SAFE_METHODS.has(request.method) &&
        !url.pathname.endsWith(".data")
      ) {
        return withSecurityHeaders(demoReadOnly());
      }
      if (
        camp.status === "suspended" &&
        !SAFE_METHODS.has(request.method) &&
        !suspendedWriteAllowed(route)
      ) {
        return withSecurityHeaders(suspended());
      }
      if (url.pathname === CLIENT_ERROR_PATH && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const metric = clientErrorMetric(await serverBuild(), form.get("type"), form.get("route"));
        if (metric && camp.kind !== "demo" && featureOn(env, "usage"))
          cf.deferred?.push(recordUsage(clients, camp, [metric], null));
        return withSecurityHeaders(new Response(null, { status: 204 }));
      }
      // Links in emails, sign-in and origin checks use the camp's own address.
      Object.assign(cf, {
        env: {
          ...env,
          APP_URL: url.origin,
          ...(camp.kind === "demo" ? { PHOTOS: readOnlyBucket(env.PHOTOS) } : {}),
        },
        camp,
        clients,
      });
      const context = new RouterContextProvider();
      context.set(cloudflareContext, cf as CloudflareContext);
      const response = await requestHandler(request, context);
      // R74: counted after the response, never holding it up (the demo saves nothing). Only
      // where the instance keeps usage counts (config features.usage, open-source plan 3.7).
      if (camp.kind !== "demo" && featureOn(env, "usage")) {
        const metrics = responseMetrics(
          await matchRoute(url.pathname),
          request.method,
          response.status,
        );
        cf.deferred?.push(recordUsage(clients, camp, metrics, cf.personId ?? null));
      }
      if (cf.setCookies?.length) {
        const headers = new Headers(response.headers);
        for (const c of cf.setCookies) headers.append("Set-Cookie", c);
        return withSecurityHeaders(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          }),
        );
      }
      return withSecurityHeaders(response);
    } finally {
      ctx.waitUntil(finishRequest(cf as CloudflareContext));
    }
  },

  // Once a day: key-date reminder emails (app/lib/daily.server.ts).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  },
} satisfies ExportedHandler<Env>;
