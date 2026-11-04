// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";
import { listCamps } from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import type { Route } from "./+types/ops._index";

// Every camp, with counts and statuses only (R38): no member names, contacts or content.
export async function loader({ context }: Route.LoaderArgs) {
  const { sql, env } = context.get(opsContext);
  return { camps: await listCamps(sql), domain: env.PLATFORM_DOMAIN };
}

const day = (s: string | null) => (s ? s.slice(0, 10) : "—");

export default function Camps({ loaderData }: Route.ComponentProps) {
  const { camps, domain } = loaderData;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Camps</h1>
        <Link to="/ops/camps/new" className="rounded bg-black px-3 py-1.5 text-sm text-white">
          New camp
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-3">Camp</th>
              <th className="pr-3">Status</th>
              <th className="pr-3">Created</th>
              <th className="pr-3 text-right">Members</th>
              <th className="pr-3 text-right">Invites</th>
              <th className="pr-3 text-right">Sent 7d</th>
              <th className="pr-3 text-right">Bounces</th>
              <th className="pr-3 text-right">Complaints</th>
              <th className="pr-3">Last activity</th>
              <th className="pr-3">Daily limit</th>
            </tr>
          </thead>
          <tbody>
            {camps.map((c) => (
              <tr key={c.id} className="border-b align-top">
                <td className="py-2 pr-3">
                  <Link to={`/ops/camps/${c.id}`} className="font-semibold underline">
                    {c.name}
                  </Link>
                  <span className="block text-xs opacity-70">{`${c.slug}.${domain}${c.kind === "demo" ? " · demo" : ""}`}</span>
                </td>
                <td className="pr-3">
                  {c.status}
                  {c.sendingPaused && <span className="block text-xs">email paused</span>}
                </td>
                <td className="pr-3">{day(c.createdAt)}</td>
                <td className="pr-3 text-right">{c.members}</td>
                <td className="pr-3 text-right">{c.invitesPending}</td>
                <td className="pr-3 text-right">{c.emailsSent7d}</td>
                <td className="pr-3 text-right">{c.bounces7d}</td>
                <td className="pr-3 text-right">{c.complaints7d}</td>
                <td className="pr-3">{day(c.lastActivity)}</td>
                <td className="pr-3">{c.dailySendCap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
