// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { describeHistory } from "~/lib/history-labels";

describe("describeHistory", () => {
  it.each([
    ["role_granted", null, { role: "lead" }, "Made Lead"],
    ["role_revoked", { role: "treasurer" }, null, "Treasurer role removed"],
    ["position_assigned", null, { position: "Decor", year: 2027 }, "Elected Decor for 2027"],
    [
      "volunteer_signed_up",
      null,
      { role: "MOOP Lead", year: 2027 },
      "Took the job MOOP Lead",
    ],
    ["rsvp_updated", null, { intent: "going" }, "RSVP: Going"],
    [
      "rsvp_updated",
      { intent: "going", arrivalDate: null },
      { intent: "going", arrivalDate: "2027-08-25" },
      "RSVP updated: arrival",
    ],
    ["dues_updated", null, { status: "paid", amountCents: 25000 }, "Dues recorded as paid ($250)"],
    ["dues_updated", null, { status: "waived" }, "Dues waived"],
    [
      "ticket_request_saved",
      null,
      { ticketsNeeded: 2, vehiclePassNeeded: true },
      "Ticket request: 2 tickets and a vehicle pass",
    ],
    [
      "email_changed_by_lead",
      { email: "old@example.com" },
      { email: "new@example.com" },
      "Email changed: old@example.com → new@example.com",
    ],
    [
      "person_updated",
      { playaName: "A", phone: "1" },
      { playaName: "B", phone: "1" },
      "Details edited: playa name",
    ],
    ["camp_year_set", null, { year: 2025, attended: true }, "Camp year 2025 set to Came"],
    ["sap_approved", null, { day: "2027-08-24", serial: "X9" }, "SAP approved for Aug 24, pass X9"],
    ["directory_choice", null, { share: false }, "Chose not to be in the directory"],
    ["something_new", null, null, "something new"],
  ])("%s", (action, before, after, text) => {
    expect(describeHistory(action, before, after)).toBe(text);
  });
});
