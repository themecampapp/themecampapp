// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Issue #78: a camper's optional mailing address, so the camp can post them something. Kept as
// separate parts (so it exports cleanly for labels and mail merge) and works for any country.
// Only the camper, Leads and Admins see it. No server-only imports here.

export type MailingAddress = {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null; // state, province or county
  postalCode: string | null;
  country: string;
};

export const MAILING_FIELDS = [
  { key: "line1", label: "Street address", max: 120, autoComplete: "address-line1" },
  { key: "line2", label: "Apartment, unit, etc.", max: 120, autoComplete: "address-line2" },
  { key: "city", label: "City or town", max: 80, autoComplete: "address-level2" },
  { key: "region", label: "State, province or region", max: 80, autoComplete: "address-level1" },
  { key: "postalCode", label: "ZIP or postal code", max: 20, autoComplete: "postal-code" },
  { key: "country", label: "Country", max: 60, autoComplete: "country-name" },
] as const;

export type MailingField = (typeof MAILING_FIELDS)[number]["key"];

// The form's fields as typed ("mailing_line1"...) -> an address, null when they're all empty,
// or the reason it can't be saved.
export function readMailingAddress(
  get: (name: string) => string,
): { address: MailingAddress | null } | { problem: string } {
  const v = Object.fromEntries(
    MAILING_FIELDS.map((f) => [f.key, get(`mailing_${f.key}`).trim().replace(/\s+/g, " ")]),
  ) as Record<MailingField, string>;
  if (MAILING_FIELDS.every((f) => !v[f.key])) return { address: null };
  for (const f of MAILING_FIELDS) {
    if (v[f.key].length > f.max)
      return { problem: `Keep the ${f.label.toLowerCase()} under ${f.max} characters.` };
  }
  if (!v.line1 || !v.city || !v.country) {
    return { problem: "A mailing address needs at least a street address, a city and a country." };
  }
  return {
    address: {
      line1: v.line1,
      line2: v.line2 || null,
      city: v.city,
      region: v.region || null,
      postalCode: v.postalCode || null,
      country: v.country,
    },
  };
}

// As it goes on an envelope.
export function mailingLines(a: MailingAddress | null): string[] {
  if (!a) return [];
  const cityLine = [a.city, [a.region, a.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [a.line1, a.line2, cityLine, a.country].filter((l): l is string => !!l);
}
