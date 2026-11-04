// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, useSearchParams } from "react-router";
import { btn, input, PageHeader } from "~/components/ui";
import { AUTH_EVENTS, deviceLabel } from "~/lib/auth-events";
import { listAuthEvents, stuckSignIns } from "~/lib/auth-log.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import type { Route } from "./+types/_app.admin.logs";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Sign-in log · Admin") }];
}

const PAGE = 100;

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const db = getDb(context);
  const event = url.searchParams.get("event") ?? "";
  const before = url.searchParams.get("before") ?? "";
  const rows = await listAuthEvents(db, {
    q: url.searchParams.get("q") ?? "",
    event: event in AUTH_EVENTS ? event : undefined,
    before: before && !Number.isNaN(Date.parse(before)) ? before : undefined,
    limit: PAGE,
  });
  // The "stuck" summary is for the unfiltered first page only.
  const filtered = ["q", "event", "before"].some((k) => url.searchParams.get(k));
  return { rows, more: rows.length === PAGE, stuck: filtered ? [] : await stuckSignIns(db) };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

const eventLabel = (e: string) => AUTH_EVENTS[e as keyof typeof AUTH_EVENTS] ?? e;

const FAILED = new Set(["link_not_sent", "link_send_failed", "sign_in_failed", "not_linked"]);

function Detail({ d }: { d: Record<string, unknown> | null }) {
  if (!d) return null;
  const parts: string[] = [];
  if (d.throttled) parts.push(`too many requests (per ${d.throttled}), no link sent`);
  if (d.link === "expired") parts.push("link had expired");
  if (d.link === "used_or_unknown") parts.push("link already used or replaced");
  if (d.alreadySignedIn) parts.push("already signed in on this device");
  if (d.error) parts.push(`error: ${d.error}`);
  return parts.length ? <span className="block text-charcoal">{parts.join("; ")}</span> : null;
}

export default function SignInLog({ loaderData }: Route.ComponentProps) {
  const { rows, more, stuck } = loaderData;
  const [params] = useSearchParams();
  const older = new URLSearchParams(params);
  if (rows.length) older.set("before", rows[rows.length - 1].at);
  return (
    <section className="space-y-5">
      <PageHeader title="Sign-in log" />
      <p className="max-w-2xl text-sm text-charcoal">
        Every step of signing in: asking for a link, the email going out, opening the link, and
        getting in. Use it when someone says they can't sign in. Kept for 90 days. Links and tokens
        are never recorded.
      </p>

      {stuck.length > 0 && (
        <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">
            Asked for a link but haven't signed in since (last 7 days)
          </h2>
          <ul className="divide-y divide-dust-light text-sm">
            {stuck.map((s) => (
              <li key={s.email} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
                <span>
                  {s.personId ? (
                    <Link to={`/people/${s.personId}`} className="font-medium underline">
                      {s.name}
                    </Link>
                  ) : (
                    <span className="font-medium">Not in the app</span>
                  )}{" "}
                  <span className="text-charcoal">{s.email}</span>
                </span>
                <span className="text-charcoal" suppressHydrationWarning>
                  {`${s.requests} ${s.requests === 1 ? "request" : "requests"}, last ${when(s.lastRequest)} · ${eventLabel(s.lastEvent)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block font-medium">Name or email</span>
          <input name="q" defaultValue={params.get("q") ?? ""} className={`${input} w-64`} />
        </label>
        <label className="text-sm">
          <span className="block font-medium">Step</span>
          <select
            name="event"
            defaultValue={params.get("event") ?? ""}
            className={`${input} w-auto`}
          >
            <option value="">All steps</option>
            {Object.entries(AUTH_EVENTS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={btn.secondary}>
          Filter
        </button>
        {(params.get("q") || params.get("event") || params.get("before")) && (
          <Link to="/admin/logs" className="text-sm underline">
            Clear
          </Link>
        )}
      </Form>

      {rows.length === 0 ? (
        <p className="text-sm text-charcoal">Nothing logged yet.</p>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white text-sm ring-1 ring-dust-light">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 px-4 py-2 sm:grid-cols-[9rem_1fr_12rem]">
              <span className="text-charcoal" suppressHydrationWarning>
                {when(r.at)}
              </span>
              <span>
                <span className={`font-medium ${FAILED.has(r.event) ? "text-coral-ink" : ""}`}>
                  {eventLabel(r.event)}
                </span>
                {" · "}
                {r.personId ? (
                  <Link to={`/people/${r.personId}`} className="underline">
                    {r.name}
                  </Link>
                ) : null}{" "}
                <span className="text-charcoal">{r.email ?? "unknown email"}</span>
                <Detail d={r.detail} />
              </span>
              <span className="text-charcoal" title={r.userAgent ?? undefined}>
                {[deviceLabel(r.userAgent), r.ip].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more && (
        <Link to={`/admin/logs?${older}`} className="text-sm underline">
          Older entries →
        </Link>
      )}
    </section>
  );
}
