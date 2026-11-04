// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KEY_DATE_ACTIONS } from "~/db/schema";

// What a key date can be tied to (R63), shared by the Lead page and the home page.
export type KeyDateAction = (typeof KEY_DATE_ACTIONS)[number];

export const ACTION_LABEL: Record<KeyDateAction, string> = {
  tickets_close: "Ticket requests close",
  dues_due: "Dues are due",
  rsvp_by: "RSVP by",
};

// A date's reminder email goes out this many days before it (reminders.server.ts).
export const REMIND_DAYS_BEFORE = 3;
