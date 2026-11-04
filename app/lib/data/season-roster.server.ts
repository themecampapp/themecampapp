// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import { SHARES_CONTACT } from "../contact-sharing.server";
import type { Db } from "../db.server";
import { type Filters, type Rsvp, readRosterQuery } from "../roster-filters";

// The season roster (Lead workspace plan, Unit 5): one row per person in this season's camp
// (active, and either RSVP'd or invited), with what Leads ask about most. Dues are selected
// only for a Treasurer (or Admin); for anyone else they're never read from the database.

export type SeasonRow = {
  id: string;
  name: string; // playa name, or the legal name
  legalName: string;
  email: string | null;
  phone: string | null;
  invited: boolean;
  rsvp: Rsvp;
  arrivalDate: string | null;
  departureDate: string | null;
  dwelling: string | null;
  generator: boolean;
  ticket:
    | { state: "none" }
    | { state: "elsewhere" }
    | { state: "requested"; tickets: number; vehiclePass: boolean };
  sap:
    | { state: "none" }
    | { state: "pending"; day: string | null }
    | { state: "approved"; day: string | null; pass: string | null }
    | { state: "denied" };
  roles: string[];
  yearsCamped: number;
  dues: "unpaid" | "paid" | "waived" | null; // null: not visible to this viewer
};

// `dues`: whether this viewer may see who has paid (Dues, with the feature on). `contact`:
// whether they see everyone's email and phone (Private details & notes, issue #93); without
// it, only of people who share theirs in the directory.
export async function seasonRows(
  db: Db,
  { dues, contact }: { dues: boolean; contact: boolean },
): Promise<SeasonRow[]> {
  const rows = await db.execute<{
    id: string;
    legal_name: string;
    playa_name: string | null;
    shares: boolean;
    email: string | null;
    phone: string | null;
    invited: boolean;
    intent: Exclude<Rsvp, "none"> | null;
    arrival_date: string | null;
    departure_date: string | null;
    dwelling_description: string | null;
    dwelling_size: string | null;
    generator: boolean | null;
    sap_requested: boolean | null;
    sap_date: string | null;
    requested: boolean;
    tickets_needed: number | null;
    elsewhere: boolean | null;
    vehicle_pass: boolean | null;
    sap_status: "approved" | "denied" | null;
    approved_date: string | null;
    pass_serial: string | null;
    roles: string[] | null;
    years: number;
    dues_status: "unpaid" | "paid" | "waived" | null;
  }>(sql`
    with season as (select id from burn where year = current_year())
    select p.id, p.legal_name, p.playa_name, p.email, p.phone,
      ${SHARES_CONTACT} as shares,
      (p.auth_user_id is not null or exists (
        select 1 from invite i where i.person_id = p.id and i.status = 'pending')) as invited,
      pa.intent, pa.arrival_date::text as arrival_date, pa.departure_date::text as departure_date,
      pa.dwelling_description, pa.dwelling_size, pa.generator, pa.sap_requested,
      pa.sap_date::text as sap_date,
      (tr.id is not null) as requested, tr.tickets_needed, tr.has_ticket_elsewhere as elsewhere,
      tr.vehicle_pass_needed as vehicle_pass,
      sr.status as sap_status, sr.approved_date::text as approved_date, sp.serial as pass_serial,
      (select json_agg(r.title order by r.sort) from volunteer_signup s
        join volunteer_role r on r.id = s.role_id and not r.retired
        where s.person_id = p.id and s.burn_id = season.id) as roles,
      (select count(*) from participation x join burn b on b.id = x.burn_id
        where x.person_id = p.id and x.attended and b.year < current_year())::int as years,
      ${dues ? sql`d.status` : sql`null::text`} as dues_status
    from person p
    cross join season
    left join participation pa on pa.person_id = p.id and pa.burn_id = season.id
    left join ticket_request tr on tr.participation_id = pa.id and tr.active
    left join sap_review sr on sr.participation_id = pa.id
    left join sap_pass sp on sp.holder_participation_id = pa.id
    ${dues ? sql`left join dues d on d.participation_id = pa.id` : sql``}
    where p.active and (pa.id is not null or p.auth_user_id is not null or exists (
      select 1 from invite i where i.person_id = p.id and i.status = 'pending'))
  `);
  return rows.map((r): SeasonRow => {
    const coming = r.intent === "going" || r.intent === "leaning_yes";
    return {
      id: r.id,
      name: r.playa_name ?? r.legal_name,
      legalName: r.legal_name,
      email: contact || r.shares ? r.email : null,
      phone: contact || r.shares ? r.phone : null,
      invited: r.invited,
      rsvp: r.intent ?? "none",
      arrivalDate: r.arrival_date,
      departureDate: r.departure_date,
      dwelling: [r.dwelling_description, r.dwelling_size].filter(Boolean).join(" · ") || null,
      generator: r.generator === true,
      ticket: !r.requested
        ? { state: "none" }
        : r.elsewhere
          ? { state: "elsewhere" }
          : {
              state: "requested",
              tickets: Number(r.tickets_needed ?? 0),
              vehiclePass: r.vehicle_pass === true,
            },
      sap:
        r.sap_status === "approved"
          ? { state: "approved", day: r.approved_date, pass: r.pass_serial }
          : r.sap_status === "denied"
            ? { state: "denied" }
            : r.sap_requested && coming
              ? { state: "pending", day: r.sap_date }
              : { state: "none" },
      roles: r.roles ?? [],
      yearsCamped: Number(r.years),
      dues: dues ? (r.dues_status ?? (coming ? "unpaid" : null)) : null,
    };
  });
}

const coming = (r: SeasonRow) => r.rsvp === "going" || r.rsvp === "leaning_yes";
const RSVP_ORDER: Rsvp[] = ["going", "leaning_yes", "leaning_no", "not_going", "none"];
const byName = (a: SeasonRow, b: SeasonRow) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

// The rows a view shows, in its order. (Pilot camps are a few hundred people at most, so this
// runs over the season's rows in memory; see the plan's paging threshold.)
export function applyFilters(rows: SeasonRow[], f: Filters): SeasonRow[] {
  const q = f.q.toLowerCase();
  const out = rows.filter(
    (r) =>
      (!q || [r.name, r.legalName, r.email ?? ""].some((v) => v.toLowerCase().includes(q))) &&
      (!f.coming || coming(r)) &&
      (!f.rsvp || (f.rsvp === "none" ? r.rsvp === "none" && r.invited : r.rsvp === f.rsvp)) &&
      (!f.ticket ||
        (f.ticket === "missing"
          ? coming(r) && r.ticket.state === "none"
          : r.ticket.state === f.ticket)) &&
      (!f.sap ||
        (f.sap === "requested"
          ? r.sap.state !== "none"
          : f.sap === "pending"
            ? r.sap.state === "pending"
            : r.sap.state === f.sap)) &&
      (!f.volunteer || (f.volunteer === "none" ? r.roles.length === 0 : r.roles.length > 0)) &&
      (!f.dues || r.dues === f.dues) &&
      (!f.generator || r.generator),
  );
  const sorts: Record<Filters["sort"], (a: SeasonRow, b: SeasonRow) => number> = {
    name: byName,
    arrival: (a, b) =>
      (a.arrivalDate ?? "9999").localeCompare(b.arrivalDate ?? "9999") || byName(a, b),
    rsvp: (a, b) => RSVP_ORDER.indexOf(a.rsvp) - RSVP_ORDER.indexOf(b.rsvp) || byName(a, b),
    years: (a, b) => b.yearsCamped - a.yearsCamped || byName(a, b),
  };
  return out.sort(sorts[f.sort]);
}

// The counts at the top of the roster, over the whole season.
export function seasonCounts(rows: SeasonRow[], treasurer: boolean) {
  const n = (f: (r: SeasonRow) => boolean) => rows.filter(f).length;
  return {
    going: n((r) => r.rsvp === "going"),
    leaningYes: n((r) => r.rsvp === "leaning_yes"),
    leaningNo: n((r) => r.rsvp === "leaning_no"),
    notGoing: n((r) => r.rsvp === "not_going"),
    noRsvp: n((r) => r.rsvp === "none" && r.invited),
    missingTicket: n((r) => coming(r) && r.ticket.state === "none"),
    pendingSap: n((r) => r.sap.state === "pending"),
    noVolunteer: n((r) => coming(r) && r.roles.length === 0),
    // Null for anyone who can't see dues.
    unpaid: treasurer ? n((r) => coming(r) && r.dues === "unpaid") : null,
  };
}

// A roster view worked out again from its query string ("?preset=…&rsvp=…"), as the roster
// page shows it: what selection actions and the export act on. `treasurer` is whether this
// viewer may see dues (Dues, with the feature on).
export async function rosterView(
  db: Db,
  { dues: treasurer, contact }: { dues: boolean; contact: boolean },
  search: string,
) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const query = readRosterQuery(params, treasurer);
  const rows = applyFilters(await seasonRows(db, { dues: treasurer, contact }), query.filters);
  return { ...query, rows };
}
