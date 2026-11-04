// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import { can, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import { SHARES_CONTACT } from "../contact-sharing.server";
import type { Db } from "../db.server";
import { formatCents } from "../dues";
import type { MailingAddress } from "../mailing-address";
import { getCampSettings } from "./camp-settings.server";
import { parseYears } from "./history.server";
import { currentYear } from "./participation.server";
import { rolesFor } from "./volunteer.server";

// The Leads' "Export CSV" on the People page: everyone in the database (deactivated people
// included, marked), with contact details, sign-in and RSVP status, camp years, this season's
// ticket request and notes, plus dues when a Treasurer exports (dues are Treasurer-only).
// Lead-only, and every export is audited.

const INTENT: Record<string, string> = {
  going: "Going",
  leaning_yes: "Leaning yes",
  leaning_no: "Leaning no",
  not_going: "Not going",
};
// The columns of notes Leads keep (issue #93: Private details & notes).
const NOTE_COLUMNS = new Set(["Ticket note", "2026 note (Leads)", "Inquiry notes"]);

const yesNo = (v: boolean | null) => (v === null ? "" : v ? "Yes" : "No");

// Quotes a cell, and defuses values a spreadsheet would run as a formula (CSV injection).
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const toCsv = (rows: Array<Array<string | number | null>>) =>
  // A byte-order mark so Excel reads the file as UTF-8 (playa names often have emoji).
  `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;

export async function peopleCsv(db: Db, actor: Viewer): Promise<string> {
  const year = await currentYear(db);
  const rows = await db.execute<{
    id: string;
    legal_name: string;
    playa_name: string | null;
    email: string | null;
    phone: string | null;
    home_location: string | null;
    mailing_address: MailingAddress | null;
    active: boolean;
    signed_in: boolean;
    invite_pending: boolean;
    roles: string | null;
    shares_contact: boolean;
    camp_years: string | null;
    intent: string | null;
    intent_by_lead: boolean;
    arrival_date: string | null;
    departure_date: string | null;
    sap_requested: boolean | null;
    sap_date: string | null;
    dwelling_description: string | null;
    dwelling_size: string | null;
    generator: boolean | null;
    tickets_needed: number | null;
    has_elsewhere: boolean | null;
    vp_needed: boolean | null;
    request_active: boolean | null;
    ticket_note: string | null;
    dues_status: string | null;
    dues_tier: string | null;
    dues_amount_cents: number | null;
    dues_paid_on: string | null;
    dues_method: string | null;
    note_2026: string | null;
    inquiry_notes: string | null;
    created_at: string;
  }>(sql`
    select p.id, p.legal_name, p.playa_name, p.email, p.phone, p.home_location,
      p.mailing_address, p.active,
      p.auth_user_id is not null as signed_in,
      exists (select 1 from invite i where i.person_id = p.id and i.status = 'pending') as invite_pending,
      (select string_agg(coalesce(cr.name, initcap(mr.role)), ', ' order by mr.role, cr.name)
        from member_role mr left join camp_role cr on cr.id = mr.custom_role_id
        where mr.person_id = p.id and mr.revoked_at is null) as roles,
      ${SHARES_CONTACT} as shares_contact,
      (select string_agg(b.year::text, ',' order by b.year) from participation cy
        join burn b on b.id = cy.burn_id
        where cy.person_id = p.id and cy.attended and b.year < current_year()) as camp_years,
      pa.intent,
      (pa.updated_by_person_id is not null and pa.updated_by_person_id <> p.id) as intent_by_lead,
      pa.arrival_date, pa.departure_date, pa.sap_requested, pa.sap_date,
      pa.dwelling_description, pa.dwelling_size, pa.generator,
      r.tickets_needed, r.has_ticket_elsewhere as has_elsewhere, r.vehicle_pass_needed as vp_needed,
      r.active as request_active, r.note as ticket_note,
      d.status as dues_status, t.name as dues_tier, d.amount_cents as dues_amount_cents, d.paid_on as dues_paid_on,
      d.method as dues_method,
      p.note_2026,
      (select string_agg(n.body, ' | ' order by n.created_at) from inquiry q
        join inquiry_note n on n.inquiry_id = q.id where q.person_id = p.id) as inquiry_notes,
      p.created_at::date::text as created_at
    from person p
    left join participation pa on pa.person_id = p.id
      and pa.burn_id = (select id from burn where year = current_year())
    left join ticket_request r on r.participation_id = pa.id
    left join dues d on d.participation_id = pa.id
    left join dues_tier t on t.id = d.tier_id
    order by p.active desc, lower(coalesce(p.playa_name, p.legal_name))
  `);

  const volunteering = await rolesFor(
    db,
    rows.map((r) => r.id),
  );
  const coming = (intent: string | null) => intent === "going" || intent === "leaning_yes";
  const header = [
    "Name",
    "Playa name",
    "Email",
    "Phone",
    "Home location",
    // Issue #78: separate columns, ready for labels or a mail merge.
    "Mailing address",
    "Mailing address line 2",
    "Mailing city",
    "Mailing state or region",
    "Mailing postal code",
    "Mailing country",
    "Active",
    "Roles",
    "Sign-in",
    "Shares contact in directory",
    "Camp years",
    `${year} RSVP`,
    "RSVP set by a Lead",
    "Arrival",
    "Departure",
    "SAP requested",
    "SAP day requested",
    "Dwelling",
    "Dwelling size",
    "Generator",
    "Tickets requested",
    "Vehicle pass",
    "Ticket elsewhere",
    "Ticket note",
    "Jobs",
    "Dues",
    "Dues tier",
    "Dues amount",
    "Dues paid on",
    "Dues method",
    "2026 note (Leads)",
    "Inquiry notes",
    "Added",
  ];
  // Issue #93: without Private details & notes, contact details only for people who share
  // them in the directory, and no mailing addresses or notes.
  const seesPrivate = can(actor, "private");
  const body = rows.map((r) => {
    const request = r.request_active ? r : null;
    const contact = seesPrivate || r.shares_contact || r.id === actor.personId;
    // Dues are owed only by campers coming this year; show what's recorded, else Unpaid.
    const dues = r.dues_status ?? (coming(r.intent) ? "unpaid" : null);
    return [
      r.legal_name,
      r.playa_name,
      contact ? r.email : "",
      contact ? r.phone : "",
      contact ? r.home_location : "",
      r.mailing_address?.line1 ?? "",
      r.mailing_address?.line2 ?? "",
      r.mailing_address?.city ?? "",
      r.mailing_address?.region ?? "",
      r.mailing_address?.postalCode ?? "",
      r.mailing_address?.country ?? "",
      r.active ? "Yes" : "No (deactivated)",
      r.roles,
      r.signed_in ? "Signed in" : r.invite_pending ? "Invited" : "Not invited",
      r.shares_contact ? "Yes" : "No",
      parseYears(r.camp_years).join(", "),
      r.intent ? INTENT[r.intent] : "No RSVP",
      r.intent ? yesNo(r.intent_by_lead) : "",
      r.arrival_date,
      r.departure_date,
      yesNo(r.sap_requested),
      r.sap_date,
      r.dwelling_description,
      r.dwelling_size,
      yesNo(r.generator),
      request && !request.has_elsewhere ? Number(request.tickets_needed ?? 0) : "",
      request ? yesNo(request.vp_needed) : "",
      request ? yesNo(request.has_elsewhere) : "",
      r.ticket_note,
      (volunteering.get(r.id) ?? []).join(", "),
      dues ? dues[0].toUpperCase() + dues.slice(1) : "",
      dues ? (r.dues_tier ?? "Standard") : "",
      r.dues_amount_cents === null ? "" : formatCents(Number(r.dues_amount_cents)),
      r.dues_paid_on,
      r.dues_method ? r.dues_method[0].toUpperCase() + r.dues_method.slice(1) : "",
      r.note_2026,
      r.inquiry_notes,
      r.created_at,
    ];
  });

  // Who has paid dues is for people with Dues, so others get the file without them.
  // Mailing addresses are in it only while the camp collects them (issue #78), and they and
  // the notes only for people with Private details & notes (issue #93).
  const { features } = await getCampSettings(db);
  const hidden = new Set(
    header.flatMap((h, i) =>
      (h.startsWith("Dues") && !can(actor, "dues")) ||
      (h.startsWith("Mailing") && !(features.mailing && seesPrivate)) ||
      (NOTE_COLUMNS.has(h) && !seesPrivate)
        ? [i]
        : [],
    ),
  );
  const keep = <T>(cells: T[]) => cells.filter((_, i) => !hidden.has(i));

  await audit(db, {
    actorPersonId: actor.personId,
    action: "people_exported",
    subjectType: "person",
    subjectId: null,
    after: { rows: rows.length, dues: can(actor, "dues") },
  });
  return toCsv([keep(header), ...body.map(keep)]);
}
