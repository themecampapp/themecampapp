// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SeasonRow } from "./data/season-roster.server";
import { type Column, formatDay, RSVP_LABEL } from "./roster-filters";

// How the season roster shows each value, in words: shared by the page and its CSV export.

export const day = (d: string | null) => (d ? formatDay(d) : null);

function dates(r: SeasonRow) {
  if (!r.arrivalDate && !r.departureDate) return "";
  return `${day(r.arrivalDate) ?? "?"} → ${day(r.departureDate) ?? "?"}`;
}

function ticket(r: SeasonRow) {
  const coming = r.rsvp === "going" || r.rsvp === "leaning_yes";
  if (r.ticket.state === "none") return coming ? "Not requested" : "";
  if (r.ticket.state === "elsewhere") return "Has ticket elsewhere";
  const t = `${r.ticket.tickets} ${r.ticket.tickets === 1 ? "ticket" : "tickets"} requested`;
  return r.ticket.vehiclePass ? `${t} + vehicle pass` : t;
}

function sap(r: SeasonRow) {
  switch (r.sap.state) {
    case "pending":
      return `${r.sap.day ? `Asked for ${day(r.sap.day)}` : "Asked"}; to decide`;
    case "approved":
      return `Approved${r.sap.day ? ` ${day(r.sap.day)}` : ""}${r.sap.pass ? ` · pass ${r.sap.pass}` : ""}`;
    case "denied":
      return "Not approved";
    default:
      return "";
  }
}

export const DUES_LABEL = { unpaid: "Unpaid", paid: "Paid", waived: "Waived" } as const;
export const TICKET_LABEL = {
  requested: "Requested",
  elsewhere: "Has one elsewhere",
  missing: "Not requested",
} as const;
export const SAP_LABEL = {
  requested: "Asked for a SAP",
  pending: "SAP to decide",
  approved: "SAP approved",
  denied: "SAP not approved",
} as const;
export const SORT_LABEL = {
  name: "Sort by name",
  arrival: "Sort by arrival",
  rsvp: "Sort by RSVP",
  years: "Sort by years camped",
} as const;

export function cell(r: SeasonRow, c: Column) {
  switch (c) {
    case "rsvp":
      return RSVP_LABEL[r.rsvp];
    case "dates":
      return dates(r);
    case "ticket":
      return ticket(r);
    case "sap":
      return sap(r);
    case "volunteer":
      return r.roles.join(", ");
    case "years":
      return r.yearsCamped ? String(r.yearsCamped) : "";
    case "dues":
      return r.dues ? DUES_LABEL[r.dues] : "";
  }
}
