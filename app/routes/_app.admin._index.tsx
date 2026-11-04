// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { btn, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { currentYear } from "~/lib/data/participation.server";
import {
  addPastSeason,
  attendanceReview,
  FIRST_PAST_SEASON,
  pastSeasonList,
  removePastSeason,
  rollOver,
  seasons,
  switchSeason,
} from "~/lib/data/season.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.admin._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Season · Admin") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const { setup } = await getSettings(context);
  return {
    // U16: camps created in the console have the pilot agreement and the setup checklist.
    setup: setup.createdInConsole ? { checklistHidden: setup.checklistDismissed } : null,
    year: await currentYear(db),
    seasons: await seasons(db),
    review: await attendanceReview(db),
    past: await pastSeasonList(db),
    firstPast: FIRST_PAST_SEASON,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const done = (msg: string) => redirect(`/admin?notice=${encodeURIComponent(msg)}`);
  try {
    if (form.get("intent") === "add_past") {
      const year = Number(form.get("year"));
      await addPastSeason(db, viewer, year);
      return redirect(
        `/admin/seasons/${year}?notice=${encodeURIComponent(`${year} added. Tick who camped that year.`)}`,
      );
    }
    if (form.get("intent") === "remove_past") {
      const year = Number(form.get("year"));
      await removePastSeason(db, viewer, year);
      return done(`${year} removed.`);
    }
    if (form.get("intent") === "switch") {
      const year = Number(form.get("year"));
      await switchSeason(db, viewer, year);
      return done(`Switched the app to ${year}.`);
    }
    const r = await rollOver(db, viewer, {
      fromYear: Number(form.get("fromYear")),
      came: form.getAll("came").map(String),
    });
    return done(
      `Rolled over to ${r.toYear}. Recorded ${r.came} ${r.came === 1 ? "camper" : "campers"} as having come${r.didNotCome ? ` and ${r.didNotCome} as not` : ""}.`,
    );
  } catch (e) {
    return formError(e);
  }
}

const INTENT = { going: "Going", leaning_yes: "Leaning yes" } as const;

export default function Season({ loaderData, actionData }: Route.ComponentProps) {
  const { year, seasons, review, past, firstPast } = loaderData;
  const next = year + 1;
  const [params] = useSearchParams();
  return (
    <section className="max-w-2xl space-y-6">
      <PageHeader title="Season" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm">
        The app is planning <strong>{year}</strong>. RSVPs, ticket requests, the request lock, dues,
        the directory and this year's Yearbook are all for {year}.
      </p>

      <Form
        method="post"
        className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light"
        onSubmit={(e) => {
          if (!confirm(`Roll the app over from ${year} to ${next}?`)) e.preventDefault();
        }}
      >
        <h2 className="font-semibold">{`Roll over to ${next}`}</h2>
        <input type="hidden" name="fromYear" value={year} />
        <div className="space-y-2 text-sm">
          <p className="font-medium">{`1. Who came to the ${year} burn?`}</p>
          <p className="text-charcoal">
            Everyone who was Going or Leaning yes. Going is ticked to start; untick anyone who
            didn't make it and tick anyone Leaning yes who came. This becomes their {year} camp
            year: past Yearbooks, "Camped" on cards, and next year's returning-camper invites.
          </p>
          {review.length === 0 ? (
            <p className="text-charcoal">No one was Going or Leaning yes.</p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {review.map((r) => (
                <li key={r.personId}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="came" value={r.personId} defaultChecked={r.came} />
                    <span>
                      {r.name}
                      <span className="ml-1 text-xs text-charcoal">{INTENT[r.intent]}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1 text-sm">
          <p className="font-medium">2. What happens</p>
          <ul className="list-disc space-y-1 pl-5 text-charcoal">
            <li>{`The app starts planning ${next}. Everyone's RSVP, ticket request and dues start blank, and requests are unlocked.`}</li>
            <li>{`${year} becomes a past Yearbook, and "Invite returning campers" offers everyone ticked above.`}</li>
            <li>The Treasurer sets the new dues amount; the camp's guides don't change.</li>
            <li>
              Jobs stay, but nobody is in them until people sign up again or a Lead fills them (for
              example the newly elected). Existing Leads stay Leads.
            </li>
            <li>
              {`SAP requests, decisions and passes start fresh for ${next}, with no SAP days: set them under Admin → SAPs. ${year}'s passes and PDFs are kept, not deleted.`}
            </li>
            <li>Nothing is deleted. If this was a mistake, switch back below.</li>
          </ul>
        </div>
        <button type="submit" className={btn.primary}>
          {`Roll over to ${next}`}
        </button>
      </Form>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Switch season</h2>
        <p className="text-sm text-charcoal">
          To undo a rollover, or correct the current year. Attendance you've recorded stays.
        </p>
        <input type="hidden" name="intent" value="switch" />
        <div className="flex flex-wrap items-center gap-2">
          <select name="year" defaultValue={year} className={`${input} w-32`} aria-label="Season">
            {seasons.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button type="submit" className={btn.secondary}>
            Switch
          </button>
        </div>
      </Form>

      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Past seasons</h2>
        <p className="text-sm text-charcoal">
          {`Record your camp's history: add the years you camped before ${year} and tick who came. They show in past Yearbooks, as "Camped" years on people's cards, and in the People filters.`}
        </p>
        {past.length === 0 ? (
          <p className="text-sm text-charcoal">No past seasons yet.</p>
        ) : (
          <ul className="divide-y divide-dust-light text-sm">
            {past.map((p) => (
              <li key={p.year} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link to={`/admin/seasons/${p.year}`} className="font-semibold underline">
                  {p.year}
                </Link>
                <span className="flex items-center gap-3 text-charcoal">
                  {`${p.camped} camped`}
                  {!p.inUse && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_past" />
                      <input type="hidden" name="year" value={p.year} />
                      <button type="submit" className="text-sm underline">
                        Remove
                      </button>
                    </Form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Form method="post" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="add_past" />
          <label className="text-sm">
            <span className="block font-medium">Add a past season</span>
            <span className="mt-1 block w-28">
              <input
                name="year"
                type="number"
                min={firstPast}
                max={year - 1}
                required
                placeholder={String(year - 1)}
                className={input}
              />
            </span>
          </label>
          <button type="submit" className={btn.secondary}>
            Add
          </button>
        </Form>
      </div>

      {loaderData.setup && (
        <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">Camp setup</h2>
          <p className="text-sm">
            <Link to="/admin/agreement" className="underline">
              The pilot agreement
            </Link>
          </p>
          {loaderData.setup.checklistHidden && (
            <Form method="post" action="/setup-checklist">
              <input type="hidden" name="intent" value="reopen" />
              <button type="submit" className={btn.secondary}>
                Show the setup checklist on the home page again
              </button>
            </Form>
          )}
        </div>
      )}
    </section>
  );
}
