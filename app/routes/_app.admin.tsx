// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { NavLink, Outlet, useRouteLoaderData } from "react-router";
import { requireAdmin } from "~/lib/access.server";
import type { loader as appLoader } from "./_app";
import type { Route } from "./+types/_app.admin";

// Layout for Admin-only pages. Runs after the _app membership check, before any loader/action.
export const middleware: Route.MiddlewareFunction[] = [
  ({ context }) => {
    requireAdmin(context);
  },
];

const tab = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${isActive ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`;

export default function AdminLayout() {
  const features = useRouteLoaderData<typeof appLoader>("routes/_app")?.features;
  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Admin">
        <NavLink to="/admin" end className={tab}>
          Season
        </NavLink>
        <NavLink to="/admin/guide" className={tab}>
          Guide
        </NavLink>
        <NavLink to="/admin/emails" className={tab}>
          Emails
        </NavLink>
        <NavLink to="/admin/wording" className={tab}>
          Page wording
        </NavLink>
        {features?.saps && (
          <NavLink to="/admin/saps" className={tab}>
            SAPs
          </NavLink>
        )}
        <NavLink to="/admin/activity" className={tab}>
          Activity
        </NavLink>
        <NavLink to="/admin/logs" className={tab}>
          Sign-in log
        </NavLink>
        <NavLink to="/admin/settings" className={tab}>
          Settings
        </NavLink>
        <NavLink to="/admin/features" className={tab}>
          Features
        </NavLink>
        <NavLink to="/admin/roles" className={tab}>
          Roles
        </NavLink>
        <NavLink to="/admin/support" className={tab}>
          Support access
        </NavLink>
        <NavLink to="/admin/exports" className={tab}>
          Exports
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
