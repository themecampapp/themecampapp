// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The public demo camp (R67): a camp of kind "demo", filled with fictional data by
// scripts/seed-demo.ts. Anyone can look around it without an invite; nothing in it is saved.

// The seeded people a demo visitor can view the camp as (U20: the visitor picks one).
export const DEMO_LEAD_ID = "00000000-0000-4000-8000-00000000de30";
export const DEMO_ADMIN_ID = "00000000-0000-4000-8000-00000000de31";
export const DEMO_MEMBER_ID = "00000000-0000-4000-8000-00000000de32";

export const DEMO_ROLES = ["member", "lead", "admin"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

export const DEMO_ROLE: Record<DemoRole, { personId: string; label: string; sees: string }> = {
  member: {
    personId: DEMO_MEMBER_ID,
    label: "Member",
    sees: "What a camper sees: their RSVP, ticket request, dues, the Yearbook and guides.",
  },
  lead: {
    personId: DEMO_LEAD_ID,
    label: "Lead",
    sees: "What organizers see: the roster, tickets, SAPs, people, announcements and dates.",
  },
  admin: {
    personId: DEMO_ADMIN_ID,
    label: "Admin",
    sees: "Everything a Lead sees, plus dues and the camp's settings, emails and activity.",
  },
};

// A demo visit is marked by this cookie, set by /demo/enter on the demo camp's host only
// (host-only, so a browser never sends it to another camp). It carries no secret, only the
// role being viewed, and means nothing anywhere but a demo camp.
export const DEMO_COOKIE = "__Secure-demo";
const DEMO_COOKIE_RE = /(?:^|;\s*)__Secure-demo=(member|lead|admin)(?:;|$)/;

export const isDemoRole = (v: string | null): v is DemoRole =>
  (DEMO_ROLES as readonly string[]).includes(v ?? "");

export function demoRole(request: Request): DemoRole | null {
  const m = DEMO_COOKIE_RE.exec(request.headers.get("Cookie") ?? "");
  return m ? (m[1] as DemoRole) : null;
}

export const hasDemoCookie = (request: Request) => demoRole(request) !== null;

export const demoCookie = (role: DemoRole = "lead") =>
  `${DEMO_COOKIE}=${role}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
