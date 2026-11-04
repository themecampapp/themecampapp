// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link, redirect } from "react-router";
import { CampName } from "~/components/CampName";
import { btn, Notice, PageHeader } from "~/components/ui";
import { CardGrid, photoUrl, YearSwitcher, yearsText } from "~/components/Yearbook";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import { pastYearbook, pastYearbookYears } from "~/lib/data/history.server";
import { currentYear } from "~/lib/data/participation.server";
import type { Route } from "./+types/_app.yearbook.$year";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${loaderData?.year ?? ""} Yearbook`) }];
}

// A past season's Yearbook: everyone who camped that year. Campers with a photo get a card;
// the rest are listed by playa name (or first name). Members only, via the _app layout.
export async function loader({ params, context }: Route.LoaderArgs) {
  getViewer(context);
  const year = /^\d{4}$/.test(params.year) ? Number(params.year) : Number.NaN;
  const db = getDb(context);
  const current = await currentYear(db);
  if (year === current) throw redirect("/yearbook");
  const pastYears = await pastYearbookYears(db);
  if (!pastYears.includes(year)) throw data({ reason: "not_found" }, { status: 404 });
  const { cards, names } = await pastYearbook(db, year);
  return {
    year,
    current,
    pastYears,
    cards: cards.map((c) => ({ ...c, url: photoUrl(c.key) })),
    names,
  };
}

export default function PastYearbook({ loaderData }: Route.ComponentProps) {
  const { year, current, pastYears, cards, names } = loaderData;
  return (
    <section>
      <PageHeader title={`${year} Yearbook`}>
        <Link to="/profile" className={btn.secondary}>
          Your photo
        </Link>
      </PageHeader>
      <YearSwitcher current={current} past={pastYears} selected={year} />
      <p className="mb-5 text-sm text-charcoal">
        Everyone who camped with <CampName /> in {year}. Members only.
      </p>
      {cards.length > 0 ? (
        <CardGrid cards={cards} />
      ) : (
        <Notice>
          No photos from {year} yet. Campers who{" "}
          <Link to="/profile" className="font-semibold underline">
            add a photo
          </Link>{" "}
          show up here.
        </Notice>
      )}
      {names.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 font-semibold">{cards.length > 0 ? "Also in camp" : "In camp"}</h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {names.map((n, i) => (
              // Labels can repeat (two campers named Sam), so the index keeps keys unique.
              // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
              <li key={i}>
                <span className="font-medium">{n.label}</span>
                {n.years.length > 1 && (
                  <span className="block text-xs text-charcoal">{yearsText(n.years)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
