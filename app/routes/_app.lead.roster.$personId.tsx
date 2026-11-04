// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link, useLocation } from "react-router";
import { btn } from "~/components/ui";
import { can, getViewer } from "~/lib/access.server";
import { personHref } from "~/lib/back-link";
import { getDb, getSettings } from "~/lib/context.server";
import { personSummary } from "~/lib/data/person-summary.server";
import { applyFilters, seasonRows } from "~/lib/data/season-roster.server";
import { mailingLines } from "~/lib/mailing-address";
import { formatDay, RSVP_LABEL, readRosterQuery } from "~/lib/roster-filters";
import type { Route } from "./+types/_app.lead.roster.$personId";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One person beside the season roster (Lead workspace plan, Unit 6): their season at a glance,
// contact, camp years and latest History, with previous and next in the same filtered list.
// Read-only: "Edit record" opens the person page (and its rules for who may change what).
export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (!ID_RE.test(params.personId)) throw data({ reason: "not_found" }, { status: 404 });
  const viewer = getViewer(context);
  const db = getDb(context);
  const { features } = await getSettings(context);
  const treasurer = can(viewer, "dues") && features.dues;
  const { filters } = readRosterQuery(new URL(request.url).searchParams, treasurer);
  const seesPrivate = can(viewer, "private");
  const all = await seasonRows(db, { dues: treasurer, contact: seesPrivate });
  const list = applyFilters(all, filters);
  const at = list.findIndex((r) => r.id === params.personId);
  const summary = await personSummary(
    db,
    { dues: treasurer, private: seesPrivate },
    params.personId,
    all.find((r) => r.id === params.personId) ?? null,
  );
  // Row-level security: another camp's person simply isn't found.
  if (!summary) throw data({ reason: "not_found" }, { status: 404 });
  const { mailingAddress, ...rest } = summary;
  return {
    // Issue #78: the mailing address only while the camp collects them.
    person: { ...rest, mailing: features.mailing ? mailingLines(mailingAddress) : [] },
    features: { saps: features.saps, volunteer: features.volunteer, dues: treasurer },
    inList: at >= 0,
    prev: at > 0 ? list[at - 1].id : null,
    next: at >= 0 && at < list.length - 1 ? list[at + 1].id : null,
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1">
      <dt className="text-charcoal">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const day = (d: string | null) => (d ? formatDay(d) : null);

export default function PersonPanel({ loaderData }: Route.ComponentProps) {
  const { person: p, features, inList, prev, next } = loaderData;
  const { search } = useLocation();
  const s = p.season;
  const ticket = !s
    ? null
    : s.ticket.state === "elsewhere"
      ? "Has a ticket elsewhere"
      : s.ticket.state === "requested"
        ? `${s.ticket.tickets} ${s.ticket.tickets === 1 ? "ticket" : "tickets"} requested${s.ticket.vehiclePass ? " + vehicle pass" : ""}`
        : s.rsvp === "going" || s.rsvp === "leaning_yes"
          ? "Not requested"
          : null;
  const sap = !s
    ? null
    : s.sap.state === "pending"
      ? `Asked for ${day(s.sap.day) ?? "a day"}; to decide`
      : s.sap.state === "approved"
        ? `Approved${s.sap.day ? ` for ${day(s.sap.day)}` : ""}${s.sap.pass ? ` · pass ${s.sap.pass}` : ""}`
        : s.sap.state === "denied"
          ? "Not approved"
          : null;
  return (
    <aside
      aria-label={`${p.name}'s details`}
      className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light lg:sticky lg:top-4 lg:self-start"
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <Link to={`/roster${search}`} className="underline">
          ← Back to the list
        </Link>
        <span className="flex gap-3">
          {prev ? (
            <Link to={`/roster/${prev}${search}`} className="underline">
              ← Previous
            </Link>
          ) : null}
          {next ? (
            <Link to={`/roster/${next}${search}`} className="underline">
              Next →
            </Link>
          ) : null}
        </span>
      </div>
      <div>
        <h2 className="text-xl font-bold">{p.name}</h2>
        {p.name !== p.legalName && <p className="text-sm text-charcoal">{p.legalName}</p>}
        {!inList && <p className="mt-1 text-sm text-charcoal">Not in this list any more.</p>}
      </div>

      <section>
        <h3 className="font-semibold">This season</h3>
        {s ? (
          <dl className="text-sm">
            <Row label="RSVP">{RSVP_LABEL[s.rsvp]}</Row>
            <Row label="Dates">
              {s.arrivalDate || s.departureDate
                ? `${day(s.arrivalDate) ?? "?"} → ${day(s.departureDate) ?? "?"}`
                : null}
            </Row>
            <Row label="Dwelling">{s.dwelling}</Row>
            <Row label="Generator">{s.generator ? "Bringing one" : null}</Row>
            <Row label="Ticket">{ticket}</Row>
            {features.saps && <Row label="SAP">{sap}</Row>}
            {features.volunteer && <Row label="Jobs">{s.roles.join(", ")}</Row>}
            {features.dues && (
              <Row label="Dues">
                {s.dues ? { unpaid: "Unpaid", paid: "Paid", waived: "Waived" }[s.dues] : null}
              </Row>
            )}
          </dl>
        ) : (
          <p className="text-sm text-charcoal">Not part of this season yet.</p>
        )}
      </section>

      <section>
        <h3 className="font-semibold">Contact</h3>
        <dl className="text-sm">
          <Row label="Email">
            {p.email ? (
              <a href={`mailto:${p.email}`} className="break-all underline">
                {p.email}
              </a>
            ) : (
              "None yet"
            )}
          </Row>
          <Row label="Phone">{p.phone}</Row>
          <Row label="Home">{p.homeLocation}</Row>
          <Row label="Mailing address">
            {p.mailing.length ? (
              <address className="not-italic">
                {p.mailing.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </address>
            ) : null}
          </Row>
          <Row label="Camped">{p.campYears.length ? p.campYears.join(" · ") : null}</Row>
        </dl>
      </section>

      {p.recent.length > 0 && (
        <section>
          <h3 className="font-semibold">Latest</h3>
          <ul className="space-y-1 text-sm">
            {p.recent.map((h) => (
              <li key={h.id}>
                <span className="text-charcoal">{`${new Date(h.at).toLocaleDateString()} · `}</span>
                {h.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link to={personHref(p.id, `/roster/${p.id}${search}`)} className={btn.secondary}>
        Edit record
      </Link>
    </aside>
  );
}
