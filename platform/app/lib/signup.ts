// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign-up values the pages and the server share (issue #73). No server-only imports here.

export const MAX_ADMINS = 5; // a new camp's first Admins
export const SIGNUP_RETENTION_DAYS = 90; // decided requests are then removed

// As camp_signup's checks have them (app/db/schema.ts).
export const CAMP_SIZES = ["under_25", "25_50", "50_100", "over_100"] as const;
export type CampSize = (typeof CAMP_SIZES)[number];
export const CAMP_SIZE_LABEL: Record<CampSize, string> = {
  under_25: "Under 25 people",
  "25_50": "25 to 50",
  "50_100": "50 to 100",
  over_100: "Over 100",
};
export type SignupAdmin = { name: string; email: string };
