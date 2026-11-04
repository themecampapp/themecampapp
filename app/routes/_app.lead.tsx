// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Outlet } from "react-router";
import { areaForPattern, routePath } from "~/lib/permissions";
import type { Route } from "./+types/_app.lead";

// Layout for the Lead tools. Each page belongs to an area (app/lib/permissions.ts), and the _app
// middleware has already checked the viewer's level in it. A page here that belongs to no area
// is refused to everyone until someone gives it one: new pages fail closed.
export const middleware: Route.MiddlewareFunction[] = [
  ({ pattern }) => {
    if (!areaForPattern(routePath(pattern))) throw data({ reason: "forbidden" }, { status: 403 });
  },
];

export default function LeadLayout() {
  return <Outlet />;
}
