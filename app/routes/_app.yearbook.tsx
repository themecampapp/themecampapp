// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link } from "react-router";
import { PageText } from "~/components/PageText";
import { btn, input, Notice, PageHeader } from "~/components/ui";
import { CardGrid, photoUrl, YearSwitcher } from "~/components/Yearbook";
import { can, getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { directory, directoryChoice } from "~/lib/data/directory.server";
import { campYears, pastYearbookYears } from "~/lib/data/history.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { currentYear } from "~/lib/data/participation.server";
import { listRoles, rolesFor } from "~/lib/data/volunteer.server";
import { yearbook } from "~/lib/photos.server";
import type { Route } from "./+types/_app.yearbook";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Yearbook") }];
}

// This season's Yearbook: photo cards, or the Directory tab (everyone Going or Leaning yes,
// with contact details for those who chose to share them).
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const year = await currentYear(db);
  const base = {
    year,
    pastYears: await pastYearbookYears(db),
    intro: (await pageTexts(db, ["yearbook_intro"])).yearbook_intro,
    introYear: year,
  };

  const url = new URL(request.url);
  const asked = url.searchParams.get("view");
  // Until anyone has a photo this season, the Directory is the useful page.
  const cards = asked === "directory" ? [] : await yearbook(db);
  if (asked === "directory" || (asked !== "photos" && cards.length === 0)) {
    // Searches only what the Directory shows: Yearbook names, and full names people shared.
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const entries = (await directory(db, viewer)).filter(
      (e) =>
        !q ||
        e.label.toLowerCase().includes(q) ||
        (e.contact?.fullName.toLowerCase().includes(q) ?? false),
    );
    // Issue #106: the jobs marked "Show in Who's who" (the former elected positions start that
    // way), while the camp has jobs switched on.
    const jobsOn = (await getSettings(context)).features.volunteer;
    const titles = jobsOn
      ? await rolesFor(
          db,
          entries.map((e) => e.personId),
          { yearbookOnly: true },
        )
      : new Map<string, string[]>();
    return {
      ...base,
      view: "directory" as const,
      q,
      seesPrivate: can(viewer, "private"),
      choice: await directoryChoice(db, viewer.personId),
      // Who's who: each job shown there, and its people's Yearbook names.
      whosWho: jobsOn
        ? (await listRoles(db, viewer.personId))
            .filter((j) => j.showInYearbook && j.signups.length > 0)
            .map((j) => ({
              title: j.title,
              names: j.signups.map((s) => s.label).sort((a, b) => a.localeCompare(b)),
            }))
        : [],
      entries: entries.map((e) => ({
        label: e.label,
        jobs: titles.get(e.personId) ?? [],
        homeLocation: e.homeLocation,
        isYou: e.isYou,
        photoUrl: e.photoKey ? photoUrl(e.photoKey) : null,
        contact: e.contact,
      })),
    };
  }

  const years = await campYears(
    db,
    cards.map((c) => c.personId),
  );
  return {
    ...base,
    view: "photos" as const,
    // Only display fields go to the page (no person ids).
    cards: cards.map((c) => ({
      key: c.key,
      url: photoUrl(c.key),
      label: c.label,
      secondary: c.secondary,
      homeLocation: c.homeLocation,
      years: years.get(c.personId) ?? [],
    })),
  };
}

function Tabs({ view }: { view: "photos" | "directory" }) {
  const tab = (active: boolean) =>
    `rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${active ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`;
  return (
    <nav className="mb-4 flex gap-2 text-sm" aria-label="Yearbook view">
      <Link
        to="/yearbook?view=photos"
        aria-current={view === "photos" ? "page" : undefined}
        className={tab(view === "photos")}
      >
        Photos
      </Link>
      <Link
        to="/yearbook?view=directory"
        aria-current={view === "directory" ? "page" : undefined}
        className={tab(view === "directory")}
      >
        Directory
      </Link>
    </nav>
  );
}

export default function Yearbook({ loaderData }: Route.ComponentProps) {
  const { year, pastYears } = loaderData;
  return (
    <section>
      <PageHeader title={`${year} Yearbook`}>
        <Link to="/profile" className={btn.secondary}>
          Your photo
        </Link>
      </PageHeader>
      <YearSwitcher current={year} past={pastYears} selected={year} />
      <Tabs view={loaderData.view} />
      {loaderData.view === "directory" ? (
        <Directory {...loaderData} />
      ) : (
        <>
          <p className="mb-5 text-sm text-charcoal">
            <PageText text={loaderData.intro} year={loaderData.introYear} /> Everyone Going or
            Leaning yes who's added a photo is here. Members only.
          </p>
          {loaderData.cards.length === 0 ? (
            <Notice>
              No photos yet.{" "}
              <Link to="/profile" className="font-semibold underline">
                Add yours
              </Link>{" "}
              and be the first.
            </Notice>
          ) : (
            <CardGrid cards={loaderData.cards} />
          )}
        </>
      )}
    </section>
  );
}

type DirectoryData = Extract<Route.ComponentProps["loaderData"], { view: "directory" }>;

function Directory({ entries, choice, seesPrivate, whosWho, q }: DirectoryData) {
  return (
    <>
      <Form method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <input type="hidden" name="view" value="directory" />
        <input
          name="q"
          defaultValue={q}
          placeholder="Find a camper"
          aria-label="Find a camper by name"
          className={`${input} w-56`}
        />
        <button type="submit" className={btn.secondary}>
          Find
        </button>
        {q && (
          <Link to="/yearbook?view=directory" className="text-sm underline">
            Show everyone
          </Link>
        )}
      </Form>
      {whosWho.length > 0 && (
        <div className="mb-5 rounded-xl bg-gold-glow p-4 ring-1 ring-gold">
          <h2 className="mb-2 font-semibold">Who's who</h2>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {whosWho.map((p) => (
              <div key={p.title} className="flex flex-wrap gap-x-2">
                <dt className="font-medium">{`${p.title}:`}</dt>
                <dd>{p.names.join(", ")}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <p className="mb-3 text-sm text-charcoal">
        Everyone Going or Leaning yes this year, with where they're from. Email and phone show only
        for campers who chose to share them. Members only.
        {seesPrivate && " You can see everyone's contact details."}
      </p>
      <p className="mb-5 text-sm">
        {choice.sharing
          ? "You're sharing your email and phone here. "
          : "Your email and phone are hidden here. "}
        <Link to="/profile#directory" className="underline">
          Change
        </Link>
      </p>
      {entries.length === 0 ? (
        <Notice>No one has RSVP'd Going or Leaning yes yet.</Notice>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
          {entries.map((e, i) => (
            // Labels can repeat, so the index keeps keys unique.
            // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
            <li key={i} className="flex items-center gap-3 px-4 py-3">
              {e.photoUrl ? (
                <img
                  src={e.photoUrl}
                  alt=""
                  loading="lazy"
                  className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-dust-light"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-full bg-dust-pale ring-1 ring-dust-light" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {e.label}
                  {e.isYou && <span className="ml-2 text-sm text-charcoal">(you)</span>}
                  {e.jobs.map((title) => (
                    <span
                      key={title}
                      className="ml-2 rounded-full bg-gold-glow px-2 py-0.5 text-xs font-medium ring-1 ring-gold"
                    >
                      {title}
                    </span>
                  ))}
                </div>
                {e.homeLocation && <div className="text-sm text-charcoal">{e.homeLocation}</div>}
                {e.contact ? (
                  <div className="text-sm text-charcoal">
                    {e.contact.fullName !== e.label && (
                      <span className="block">{e.contact.fullName}</span>
                    )}
                    {e.contact.email && (
                      <a href={`mailto:${e.contact.email}`} className="mr-3 break-all underline">
                        {e.contact.email}
                      </a>
                    )}
                    {e.contact.phone && (
                      <a href={`tel:${e.contact.phone}`} className="underline">
                        {e.contact.phone}
                      </a>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-charcoal">Contact hidden</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
