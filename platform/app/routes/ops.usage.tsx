// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";
import { listCamps } from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import { campUsage, summarize, usageToday } from "../lib/usage.server";
import type { Route } from "./+types/ops.usage";

// R74: how every camp uses the app, as numbers only (R38): no names, emails, URLs or content.
export async function loader({ context }: Route.LoaderArgs) {
  const { sql } = context.get(opsContext);
  const [camps, rows, today] = await Promise.all([
    listCamps(sql),
    campUsage(sql, 30),
    usageToday(sql),
  ]);
  const summary = summarize(rows, today);
  return {
    camps: camps
      .filter((c) => c.status !== "pending_deletion")
      .map((c) => ({ id: c.id, slug: c.slug, kind: c.kind, usage: summary.get(c.id) ?? null })),
  };
}

const COLUMNS = [
  ["active7", "Active 7d"],
  ["active30", "Active 30d"],
  ["views7", "Views 7d"],
  ["views30", "Views 30d"],
  ["signIns7", "Sign-ins"],
  ["signInFailures7", "Sign-in fails"],
  ["actions7", "Actions"],
  ["errors4xx7", "4xx"],
  ["errors5xx7", "5xx"],
  ["clientErrors7", "Browser errors"],
  ["mailSent7", "Emails"],
  ["mailHeld7", "Held"],
  ["mailFailed7", "Failed"],
] as const;

export default function Usage({ loaderData }: Route.ComponentProps) {
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-bold">Usage</h1>
      <p className="text-sm opacity-80">
        Counts only, for the last 7 days unless marked. Active means members who used the app. Each
        camp's page has daily charts and the breakdown.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-3">Camp</th>
              {COLUMNS.map(([key, label]) => (
                <th key={key} className="pr-3 text-right">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loaderData.camps.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="py-2 pr-3">
                  <Link to={`/ops/camps/${c.id}#usage`} className="underline">
                    {c.slug}
                  </Link>
                  {c.kind === "demo" && <span className="ml-1 text-xs opacity-70">(demo)</span>}
                </td>
                {COLUMNS.map(([key]) => (
                  <td key={key} className="pr-3 text-right">
                    {c.usage ? c.usage[key] : 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
