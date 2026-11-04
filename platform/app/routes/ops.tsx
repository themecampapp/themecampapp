// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { NavLink, Outlet } from "react-router";
import { opsContext } from "../lib/context.server";
import { pendingSignups } from "../lib/signup.server";
import type { Route } from "./+types/ops";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `Operator console · ${loaderData?.product ?? ""}` },
  { name: "robots", content: "noindex" },
];

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export async function loader({ context }: Route.LoaderArgs) {
  const { operator, sql, env } = context.get(opsContext);
  return {
    product: env.PRODUCT_NAME,
    operator: { name: operator.name, email: operator.email },
    // Issue #73: sign-up requests waiting for a decision.
    signups: await pendingSignups(sql),
  };
}

const tab = ({ isActive }: { isActive: boolean }) =>
  isActive ? "font-semibold underline underline-offset-4" : "hover:underline";

export default function OpsLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <nav className="flex gap-4 text-sm" aria-label="Console">
          <span className="font-bold">Operator console</span>
          <NavLink to="/ops" end className={tab}>
            Camps
          </NavLink>
          <NavLink to="/ops/signups" className={tab}>
            {`Sign-ups${loaderData.signups ? ` (${loaderData.signups})` : ""}`}
          </NavLink>
          <NavLink to="/ops/requests" className={tab}>
            Data requests
          </NavLink>
          <NavLink to="/ops/usage" className={tab}>
            Usage
          </NavLink>
          <NavLink to="/ops/feedback" className={tab}>
            Feedback
          </NavLink>
          <NavLink to="/ops/log" className={tab}>
            Operator log
          </NavLink>
        </nav>
        <span className="text-xs opacity-70">{loaderData.operator.email}</span>
      </header>
      <Outlet />
    </div>
  );
}
