// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, useSearchParams } from "react-router";
import { btn, input, PageHeader } from "~/components/ui";
import { activityActors, listActivity } from "~/lib/activity.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import { ACTIVITY_AREAS, type ActivityArea } from "~/lib/history-labels";
import type { Route } from "./+types/_app.admin.activity";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Activity · Admin") }];
}

const PAGE = 100;
const UUID = /^[0-9a-f-]{36}$/i;

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const db = getDb(context);
  const area = url.searchParams.get("area") ?? "";
  const who = url.searchParams.get("who") ?? "";
  const before = url.searchParams.get("before") ?? "";
  const { rows, more } = await listActivity(db, {
    area: area in ACTIVITY_AREAS ? (area as ActivityArea) : undefined,
    actorId: UUID.test(who) ? who : undefined,
    operatorOnly: who === "operator",
    before: before && !Number.isNaN(Date.parse(before)) ? before : undefined,
    limit: PAGE,
  });
  return { rows, more, actors: await activityActors(db) };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function Activity({ loaderData }: Route.ComponentProps) {
  const { rows, more, actors } = loaderData;
  const { productName } = useCamp();
  const [params] = useSearchParams();
  const older = new URLSearchParams(params);
  if (rows.length) older.set("before", rows[rows.length - 1].at);
  return (
    <section className="space-y-5">
      <PageHeader title="Activity" />
      <p className="max-w-2xl text-sm text-charcoal">
        Every recorded change in the app, newest first, and who made it: people, join inquiries,
        seasons and settings, SAPs, roles and jobs. The record can't be edited or deleted. Each
        person's own changes are also in the History on their page.
      </p>

      <Form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block font-medium">Area</span>
          <select name="area" defaultValue={params.get("area") ?? ""} className={`${input} w-auto`}>
            <option value="">Everything</option>
            {Object.entries(ACTIVITY_AREAS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block font-medium">Who</span>
          <select name="who" defaultValue={params.get("who") ?? ""} className={`${input} w-auto`}>
            <option value="">Anyone</option>
            <option value="operator">{`${productName} (support)`}</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={btn.secondary}>
          Filter
        </button>
        {(params.get("area") || params.get("who") || params.get("before")) && (
          <Link to="/admin/activity" className="text-sm underline">
            Clear
          </Link>
        )}
      </Form>

      {rows.length === 0 ? (
        <p className="text-sm text-charcoal">Nothing recorded.</p>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white text-sm ring-1 ring-dust-light">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 px-4 py-2 sm:grid-cols-[10rem_1fr]">
              <span className="text-charcoal" suppressHydrationWarning>
                {when(r.at)}
              </span>
              <span>
                {r.subject &&
                  (r.subject.href ? (
                    <Link to={r.subject.href} className="font-medium underline">
                      {r.subject.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{r.subject.name}</span>
                  ))}
                {r.subject && ": "}
                {r.text}
                <span className="text-charcoal">
                  {r.actor ? (
                    <>
                      {" · by "}
                      <Link to={`/people/${r.actor.id}`} className="underline">
                        {r.actor.name}
                      </Link>
                    </>
                  ) : r.byOperator ? (
                    ` · by ${productName}`
                  ) : (
                    " · by the app"
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {more && (
        <Link to={`/admin/activity?${older}`} className="text-sm underline">
          Older entries →
        </Link>
      )}
    </section>
  );
}
