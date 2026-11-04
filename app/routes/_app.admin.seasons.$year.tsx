// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { btn, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import { pastSeasonRoster, setSeasonCampers } from "~/lib/data/season.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.admin.seasons.$year";

export function meta({ params, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${params.year} season · Admin`) }];
}

// Issue #31: who camped in a past season. Everyone the camp has is listed, people who've left
// too, so the camp's history can be filled in (Leads can also fix one person's years on their
// page).
export async function loader({ params, context }: Route.LoaderArgs) {
  const year = Number(params.year);
  const roster = Number.isInteger(year) ? await pastSeasonRoster(getDb(context), year) : null;
  if (!roster) throw data({ reason: "not_found" }, { status: 404 });
  return { year, roster };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const year = Number(params.year);
  const form = await request.formData();
  try {
    const r = await setSeasonCampers(
      getDb(context),
      getViewer(context),
      year,
      form.getAll("camped").map(String),
    );
    const msg =
      r.added || r.removed
        ? `Saved: ${r.added} added, ${r.removed} taken off.`
        : "Nothing changed.";
    return redirect(`/admin/seasons/${year}?notice=${encodeURIComponent(msg)}`);
  } catch (e) {
    return formError(e);
  }
}

function Group({
  title,
  people,
}: {
  title: string;
  people: Route.ComponentProps["loaderData"]["roster"];
}) {
  if (!people.length) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="grid gap-1 sm:grid-cols-2">
        {people.map((p) => (
          <li key={p.personId}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="camped" value={p.personId} defaultChecked={p.camped} />
              {p.name}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PastSeason({ loaderData, actionData }: Route.ComponentProps) {
  const { year, roster } = loaderData;
  const [params] = useSearchParams();
  const camped = roster.filter((p) => p.camped).length;
  return (
    <section className="max-w-2xl space-y-5">
      <Link to="/admin" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Season
      </Link>
      <PageHeader title={`Who camped in ${year}`} />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        {`Tick everyone who camped with you in ${year} (${camped} so far). They'll show in the ${year} Yearbook and have ${year} among their camp years. Unticking someone takes ${year} off them.`}
      </p>
      <Form method="post" className="space-y-5 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <Group title="In the camp" people={roster.filter((p) => p.active)} />
        <Group title="No longer in the camp" people={roster.filter((p) => !p.active)} />
        {roster.length === 0 && <p className="text-sm text-charcoal">No one is in the camp yet.</p>}
        <button type="submit" className={btn.primary}>
          Save
        </button>
      </Form>
    </section>
  );
}
