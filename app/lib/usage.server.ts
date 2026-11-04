// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchRoutes, type RouteObject, type ServerBuild } from "react-router";
import type { Clients } from "./db.server";
import type { CampRef } from "./tenancy.server";

// R74: what the camp Worker counts as it happens, per camp per day (usage_daily). Only route
// ids and fixed names are stored: never a URL, so never an id or a name from one, and never an
// error's message or stack. Counting runs after the response and never fails a request.

type RouteNode = { id: string; path?: string; index?: boolean; children: RouteNode[] };
export type RouteMatch = { id: string; page: boolean };

// The build's routes as a tree, to find which route a request was for.
export function routeMatcher(build: Pick<ServerBuild, "routes">) {
  const nodes = new Map<string, RouteNode>();
  for (const r of Object.values(build.routes)) {
    if (r) nodes.set(r.id, { id: r.id, path: r.path, index: r.index, children: [] });
  }
  const roots: RouteNode[] = [];
  for (const r of Object.values(build.routes)) {
    if (!r) continue;
    const node = nodes.get(r.id) as RouteNode;
    const parent = r.parentId ? nodes.get(r.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const hasPage = (id: string) => Boolean(build.routes[id]?.module.default);
  return (pathname: string): RouteMatch | null => {
    // A client-side navigation asks for "<path>.data" ("/_root.data" for "/").
    const path = pathname === "/_root.data" ? "/" : pathname.replace(/\.data$/, "");
    // Index routes get an empty children list, which matchRoutes accepts.
    const matches = matchRoutes(roots as unknown as RouteObject[], path);
    const id = matches?.[matches.length - 1]?.route.id;
    return id ? { id, page: hasPage(id) } : null;
  };
}

// The counts for one response: a page view (a page, fetched successfully), and any error
// status, under the route's id.
export function responseMetrics(
  match: RouteMatch | null,
  method: string,
  status: number,
): string[] {
  const metrics: string[] = [];
  if (match?.page && (method === "GET" || method === "HEAD") && status === 200) {
    metrics.push(`view:${match.id}`);
  }
  if (status >= 400) metrics.push(`status:${status}:${match?.id ?? "unmatched"}`);
  return metrics;
}

// Error names a browser reports, kept as they are; anything else is "Other".
const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "ChunkLoadError",
  "NetworkError",
  "AbortError",
  "SecurityError",
  "NotAllowedError",
  "QuotaExceededError",
  "Unhandled",
]);

// The browser's error beacon (app/components/ErrorBeacon.tsx): only an error type and a known
// route id are kept. Returns null for anything else.
export function clientErrorMetric(
  build: Pick<ServerBuild, "routes">,
  type: string | null,
  route: string | null,
): string | null {
  if (!route || !build.routes[route]) return null;
  return `client_error:${ERROR_TYPES.has(type ?? "") ? type : "Other"}:${route}`;
}

// Adds the counts for this camp and today, and marks the member as seen today (at most one
// write a day each), in one statement. Errors are swallowed: a lost count doesn't matter.
export async function recordUsage(
  clients: Clients,
  camp: CampRef,
  metrics: string[],
  personId: string | null,
) {
  if (!metrics.length && !personId) return;
  try {
    await clients.pool.begin(async (tx) => {
      await tx`select set_config('app.camp_id', ${camp.id}, true)`;
      if (personId) {
        await tx`update person set last_seen_on = current_date
          where id = ${personId} and last_seen_on is distinct from current_date`;
      }
      for (const metric of metrics) {
        await tx`insert into usage_daily (metric) values (${metric})
          on conflict (camp_id, day, metric) do update set count = usage_daily.count + 1`;
      }
    });
  } catch (e) {
    console.error(`usage not counted: ${e instanceof Error ? e.message : e}`);
  }
}
