// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Dues values shared by the server and the dues page (no server-only imports here).

export const DUES_STATUSES = ["unpaid", "paid", "waived"] as const;
export type DuesStatus = (typeof DUES_STATUSES)[number];

// Each camp lists its own payment methods in its settings. The defaults are stored as lowercase
// keys; anything an Admin types is shown as written.
const METHOD_LABEL: Record<string, string> = {
  venmo: "Venmo",
  zelle: "Zelle",
  cash: "Cash",
  other: "Other",
};
export const methodLabel = (method: string) => METHOD_LABEL[method] ?? method;
// What's stored for a method an Admin typed: a default's key ("Venmo" -> "venmo"), so dues
// already recorded with it still match; anything else as written.
export const methodKey = (typed: string) =>
  Object.hasOwn(METHOD_LABEL, typed.toLowerCase()) ? typed.toLowerCase() : typed;

export const formatCents = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
