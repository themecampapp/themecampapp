// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAuth } from "~/lib/context.server";
import type { Route } from "./+types/api.auth.$";

// Better Auth's HTTP endpoints. The app signs in, verifies and signs out through its own pages
// (server-side), so over HTTP only these two stay open: reading the current camp's session and
// signing out. Everything else (other endpoints, including ones that span the whole login
// across camps) is a 404 here, and disabled again in app/lib/auth.server.ts.
const OPEN = new Set(["/api/auth/get-session", "/api/auth/sign-out"]);

const notFound = () => new Response("Not found", { status: 404 });

export async function loader({ request, context }: Route.LoaderArgs) {
  if (!OPEN.has(new URL(request.url).pathname)) return notFound();
  return getAuth(context).handler(request);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (!OPEN.has(new URL(request.url).pathname)) return notFound();
  return getAuth(context).handler(request);
}
