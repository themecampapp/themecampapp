// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, useSearchParams } from "react-router";
import { PersonLink } from "~/components/PersonLink";
import { btn, INTENT_LABEL, input, Notice, PageHeader, STATUS_LABEL } from "~/components/ui";
import { can, getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import { pastSeasons } from "~/lib/data/history.server";
import { currentYear } from "~/lib/data/participation.server";
import { bulkInviteCandidates, type InviteStatus, listPeople } from "~/lib/invites.server";
import type { Route } from "./+types/_app.lead.people._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "People") }];
}

const FILTERS: Array<{ value: InviteStatus | "all" | "inactive"; label: string }> = [
  { value: "all", label: "All" },
  // The invitation states read the same everywhere (STATUS_LABEL).
  { value: "not_invited", label: STATUS_LABEL.not_invited },
  { value: "invited", label: STATUS_LABEL.invited },
  { value: "signed_in", label: STATUS_LABEL.signed_in },
  { value: "rsvpd", label: STATUS_LABEL.rsvpd },
  { value: "inactive", label: "Deactivated" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const filter = url.searchParams.get("status") ?? "all";
  const db = getDb(context);
  const years = await pastSeasons(db);
  const yearParam = Number(url.searchParams.get("year"));
  const campYear = years.includes(yearParam) ? yearParam : undefined;
  const people = await listPeople(db, {
    q,
    year: await currentYear(db),
    includeInactive: filter === "inactive",
    campYear,
    contact: can(getViewer(context), "private"),
  });
  const shown = people.filter((p) => {
    if (filter === "inactive") return !p.active;
    if (filter === "all") return true;
    if (filter === "rsvpd") return p.status === "rsvpd" || p.status === "rsvpd_by_lead";
    // Everyone who has signed in, including those who've since RSVP'd.
    if (filter === "signed_in") return p.signedIn;
    return p.status === filter;
  });
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, 0]));
  for (const p of people) {
    counts.all++;
    if (p.status !== "signed_in") counts[p.status === "rsvpd_by_lead" ? "rsvpd" : p.status]++;
    if (p.signedIn) counts.signed_in++;
  }
  return {
    people: shown,
    counts,
    years: [...years].sort(),
    campYear: campYear ?? null,
    bulkReady: (await bulkInviteCandidates(db, getViewer(context))).length,
  };
}

export default function People({ loaderData }: Route.ComponentProps) {
  const { people, counts, years, campYear, bulkReady } = loaderData;
  const [params] = useSearchParams();
  const active = params.get("status") ?? "all";
  // Builds a filter link that keeps the other filters.
  const href = (next: { status?: string; year?: number | null }) => {
    const q = new URLSearchParams();
    q.set("status", next.status ?? active);
    const y = next.year === undefined ? campYear : next.year;
    if (y) q.set("year", String(y));
    if (params.get("q")) q.set("q", params.get("q") ?? "");
    return `?${q}`;
  };
  return (
    <section>
      <PageHeader title="People">
        {bulkReady > 0 && (
          <Link to="/people/invite" className={btn.primary}>
            Invite returning campers ({bulkReady})
          </Link>
        )}
        <Link to="/people/new" className={btn.secondary}>
          Add person
        </Link>
        <Link to="/people/import" className={btn.secondary}>
          Import CSV
        </Link>
        {/* A file download, so a full browser request rather than client-side navigation. */}
        <Link to="/people/export" reloadDocument className={btn.secondary}>
          Export CSV
        </Link>
      </PageHeader>

      {params.get("notice") && (
        <div className="mb-3">
          <Notice tone="ok">{params.get("notice")}</Notice>
        </div>
      )}
      <Form method="get" className="mb-3 flex gap-2">
        <input type="hidden" name="status" value={active} />
        {campYear && <input type="hidden" name="year" value={campYear} />}
        <input
          name="q"
          defaultValue={params.get("q") ?? ""}
          placeholder="Search name, playa name or email"
          aria-label="Search people"
          className={input}
        />
        <button type="submit" className={btn.secondary}>
          Search
        </button>
      </Form>

      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            to={href({ status: f.value })}
            aria-current={active === f.value ? "page" : undefined}
            className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${active === f.value ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
          >
            {f.label}
            {f.value !== "inactive" && (
              <span className="ml-1 opacity-70">{counts[f.value] ?? 0}</span>
            )}
          </Link>
        ))}
      </nav>

      {years.length > 0 && (
        <nav
          className="mb-4 flex flex-wrap items-center gap-2 text-sm"
          aria-label="Filter by camp year"
        >
          <span className="text-charcoal">Camped in</span>
          {[null, ...years].map((y) => (
            <Link
              key={y ?? "any"}
              to={href({ year: y })}
              aria-current={campYear === y ? "page" : undefined}
              className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${campYear === y ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
            >
              {y ?? "Any year"}
            </Link>
          ))}
        </nav>
      )}

      {(active !== "all" || campYear || params.get("q")) && (
        <p className="mb-2 text-sm text-charcoal">
          {`${people.length} ${people.length === 1 ? "person" : "people"} · `}
          <Link to="/people" className="underline">
            Clear filters
          </Link>
        </p>
      )}
      {people.length === 0 ? (
        <p className="text-charcoal">No one matches.</p>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
          {people.map((p) => (
            <li key={p.id}>
              <PersonLink
                id={p.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-dust-pale"
              >
                <span>
                  <span className="font-semibold">{p.playaName ?? p.legalName}</span>
                  {p.playaName && <span className="ml-2 text-sm text-charcoal">{p.legalName}</span>}
                  <span className="block text-sm text-charcoal">{p.email ?? "no email"}</span>
                </span>
                <span className="text-right text-sm">
                  <span className="block font-medium">{STATUS_LABEL[p.status]}</span>
                  {p.intent && (
                    <span className="block text-charcoal">{INTENT_LABEL[p.intent]}</span>
                  )}
                  {p.campYears.length > 0 && (
                    <span className="block text-charcoal">{`Camped ${p.campYears.join(" · ")}`}</span>
                  )}
                </span>
              </PersonLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
