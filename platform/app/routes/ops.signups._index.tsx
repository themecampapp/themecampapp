// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link, useSearchParams } from "react-router";
import { opsContext } from "../lib/context.server";
import { SIGNUP_RETENTION_DAYS } from "../lib/signup";
import { listSignups } from "../lib/signup.server";
import type { Route } from "./+types/ops.signups._index";

// Issue #73: camps' requests from the public sign-up page, waiting ones first. Organizers'
// names and emails are shown on each request's page only.
export async function loader({ context }: Route.LoaderArgs) {
  const { sql } = context.get(opsContext);
  // Only what the list shows: organizers' names and emails stay on each request's page.
  const signups = (await listSignups(sql)).map(({ admins, note, ...s }) => ({
    ...s,
    organizers: admins.length,
  }));
  return { signups };
}

const when = (iso: string) => new Date(iso).toLocaleString();

export default function Signups({ loaderData }: Route.ComponentProps) {
  const { signups } = loaderData;
  const waiting = signups.filter((s) => s.status === "pending");
  const decided = signups.filter((s) => s.status !== "pending");
  const notice = useSearchParams()[0].get("notice");
  return (
    <section className="space-y-5">
      <h1 className="text-xl font-bold">Sign-ups</h1>
      {notice && <p className="rounded bg-green-50 p-3 text-sm">{notice}</p>}
      <p className="text-sm opacity-80">
        {`Requests from the sign-up page. Approving one creates the camp and invites its Admins. Decided requests are removed after ${SIGNUP_RETENTION_DAYS} days.`}
      </p>
      <h2 className="font-semibold">{`Waiting (${waiting.length})`}</h2>
      {waiting.length === 0 ? (
        <p className="text-sm">Nothing waiting.</p>
      ) : (
        <ul className="space-y-2">
          {waiting.map((s) => (
            <li key={s.id} className="rounded border p-3 text-sm">
              <Link to={`/ops/signups/${s.id}`} className="font-semibold underline">
                {s.campName}
              </Link>
              <span className="opacity-80">
                {` · ${s.slug} · ${s.seasonYear} · ${s.organizers} ${s.organizers === 1 ? "organizer" : "organizers"} · ${when(s.createdAt)}`}
              </span>
              {s.slugTaken && <span className="ml-2 text-red-700">address taken</span>}
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <>
          <h2 className="font-semibold">Decided</h2>
          <ul className="space-y-1 text-sm">
            {decided.map((s) => (
              <li key={s.id}>
                <Link to={`/ops/signups/${s.id}`} className="underline">
                  {s.campName}
                </Link>
                <span className="opacity-80">
                  {` · ${s.status === "approved" ? "Approved" : "Declined"} by ${s.decidedBy ?? "?"}, ${when(s.decidedAt ?? s.createdAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
