// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Where a person page's back link goes: the list the Lead opened the person from, carried in
// `?back=`. Only a relative path on one of the Lead lists below is accepted; anything else
// (another site, "//host", an Admin page) falls back to the People list.

const LISTS: Array<{ path: string; label: string }> = [
  { path: "/roster", label: "Roster" },
  { path: "/people", label: "People" },
  { path: "/tickets", label: "Stewards Sale" },
  { path: "/saps", label: "SAPs" },
  { path: "/volunteers", label: "Volunteers" },
  { path: "/inquiries", label: "Inquiries" },
  { path: "/queue", label: "Queue" },
];

export const DEFAULT_BACK = { to: "/people", label: "People" };

export function backLink(value: string | null | undefined): { to: string; label: string } {
  if (!value || value.length > 500) return DEFAULT_BACK;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_BACK;
  }
  const path = value.split(/[?#]/)[0];
  // A list itself, or an item page under the lists that have them (an inquiry; a person
  // open beside the roster).
  const list = LISTS.find(
    (l) =>
      path === l.path ||
      (path.startsWith(`${l.path}/`) && (l.path === "/inquiries" || l.path === "/roster")),
  );
  return list ? { to: value, label: list.label } : DEFAULT_BACK;
}

// A person page's address, remembering the list it's opened from.
export const personHref = (id: string, from: string) =>
  `/people/${id}?back=${encodeURIComponent(from)}`;
