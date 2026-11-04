// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Issue #93: what a role can do, as a level in each area of the camp's tools. Code checks
// areas ("can this person view dues?"), never role names. Lead and Treasurer are presets with
// the defaults below; Admin is every area at its highest level, plus the Admin pages.
//
// A plain module: pages import the catalog and the summaries too.
import type { FeatureKey, Features } from "./features";

export type AreaKey =
  | "people"
  | "private"
  | "roster"
  | "tickets"
  | "dues"
  | "saps"
  | "volunteer"
  | "inquiries"
  | "announcements"
  | "guides";

export type Level = "none" | "view" | "manage";
export type Access = Record<AreaKey, Level>;

// What a route needs, by its pattern in app/routes.ts: `read` for GET and HEAD (default view),
// `write` for everything else (default manage).
type RouteNeed = { read?: Level; write?: Level };

export type Area = {
  key: AreaKey;
  label: string;
  description: string;
  // The levels it offers, lowest first ("none" always).
  levels: Level[];
  levelHelp: Partial<Record<Level, string>>;
  // Hidden while this feature is switched off (its pages answer 404 then anyway).
  feature?: FeatureKey;
  // The summary's name for it: "Can manage <noun>".
  noun: string;
  routes: Record<string, RouteNeed>;
};

const ALL: Level[] = ["none", "view", "manage"];

export const AREAS: Area[] = [
  {
    key: "people",
    label: "People",
    description: "The camp's list of people and each person's page.",
    levels: ALL,
    levelHelp: {
      view: "See the People list and each person's page.",
      manage:
        "Also add, edit, invite and import people, deactivate them, fix sign-ins, and work the Lead queue.",
    },
    noun: "people",
    routes: {
      "/people": {},
      "/people/:id": {},
      "/people/new": { read: "manage" },
      "/people/invite": { read: "manage" },
      "/people/import": { read: "manage" },
      "/people/import/template": { read: "manage" },
      "/people/export": { read: "manage" },
      "/queue": { read: "manage" },
    },
  },
  {
    key: "private",
    label: "Private details & notes",
    description:
      "Contact details members haven't shared, mailing addresses, and the notes kept on people.",
    levels: ["none", "view"],
    levelHelp: {
      view: "See everyone's phone, email, home location and mailing address, and the notes on each person, on every page and export.",
    },
    noun: "private details and notes",
    routes: {},
  },
  {
    key: "roster",
    label: "Roster & RSVPs",
    description: "This season's roster and everyone's RSVP.",
    levels: ALL,
    levelHelp: {
      view: "See the season roster and download it.",
      manage: "Also RSVP for someone, send RSVP nudges, and record past camp years.",
    },
    noun: "the roster",
    routes: {
      "/roster": {},
      "/roster/:personId": {},
      "/roster/export": {},
      "/roster/nudge": { read: "manage" },
      "/people/:id/rsvp": {},
    },
  },
  {
    key: "tickets",
    label: "Tickets",
    description: "Stewards Sale ticket requests.",
    levels: ALL,
    levelHelp: {
      view: "See everyone's ticket requests.",
      manage: "Also lock and unlock requests.",
    },
    noun: "tickets",
    routes: { "/tickets": {} },
  },
  {
    key: "dues",
    label: "Dues",
    description: "Who has paid, and the camp's dues tiers.",
    levels: ALL,
    levelHelp: {
      view: "See who has paid and how much, on the Dues page, the roster and exports.",
      manage: "Also record payments and set up dues tiers.",
    },
    feature: "dues",
    noun: "dues",
    routes: { "/dues": {} },
  },
  {
    key: "saps",
    label: "SAPs",
    description: "Setup Access Pass requests and passes.",
    levels: ALL,
    levelHelp: {
      view: "See SAP requests and passes.",
      manage: "Also approve requests and assign passes.",
    },
    feature: "saps",
    noun: "SAPs",
    routes: { "/saps": {} },
  },
  {
    key: "volunteer",
    label: "Jobs",
    description: "The camp's jobs and who's in each one.",
    levels: ALL,
    levelHelp: {
      view: "See who's in each job.",
      manage: "Also edit the jobs, and add or remove people, including jobs only Leads fill.",
    },
    feature: "volunteer",
    noun: "jobs",
    routes: { "/volunteers": {} },
  },
  {
    key: "inquiries",
    label: "Inquiries",
    description: "People interested in joining, from the join page.",
    levels: ALL,
    levelHelp: {
      view: "See inquiries and their notes.",
      manage: "Also update them, add notes, assign them and invite people from them.",
    },
    feature: "join",
    noun: "inquiries",
    routes: { "/inquiries": {}, "/inquiries/:id": {} },
  },
  {
    key: "announcements",
    label: "Announcements & dates",
    description: "Announcements and key dates on everyone's home page.",
    levels: ["none", "manage"],
    levelHelp: { manage: "Post and edit announcements and key dates." },
    noun: "announcements",
    routes: { "/announcements": {}, "/dates": {} },
  },
  {
    key: "guides",
    label: "Guides",
    description: "The camp's guides. Everyone can read published guides.",
    levels: ["none", "manage"],
    levelHelp: { manage: "Write, edit and publish guides, and read drafts." },
    noun: "guides",
    routes: { "/guide-editor": {}, "/guide-editor/:id": {} },
  },
];

const RANK: Record<Level, number> = { none: 0, view: 1, manage: 2 };
const SENSITIVE: AreaKey[] = ["private", "dues"];

const fill = (level: Level): Access =>
  Object.fromEntries(AREAS.map((a) => [a.key, level])) as Access;

export const NO_ACCESS: Access = fill("none");
// Each area at the highest level it offers.
export const ADMIN_ACCESS: Access = Object.fromEntries(
  AREAS.map((a) => [a.key, a.levels[a.levels.length - 1]]),
) as Access;

export type BuiltinRole = "lead" | "treasurer";

// The built-in roles' defaults: exactly what Lead and Treasurer could do before issue #93.
export const BUILTIN_DEFAULTS: Record<BuiltinRole, Access> = {
  lead: { ...ADMIN_ACCESS, dues: "none" },
  treasurer: { ...NO_ACCESS, dues: "manage" },
};

// Ready-made starting points for a new custom role (not stored anywhere).
export const STARTING_POINTS: Array<{ key: string; label: string; access: Access }> = [
  { key: "lead", label: "Lead", access: BUILTIN_DEFAULTS.lead },
  { key: "treasurer", label: "Treasurer", access: BUILTIN_DEFAULTS.treasurer },
  { key: "tickets", label: "Tickets coordinator", access: { ...NO_ACCESS, tickets: "manage" } },
  {
    key: "registrar",
    label: "Registrar",
    access: { ...NO_ACCESS, people: "manage", inquiries: "manage" },
  },
  { key: "dues_viewer", label: "Dues viewer", access: { ...NO_ACCESS, dues: "view" } },
  { key: "blank", label: "Nothing (start blank)", access: NO_ACCESS },
];

export const atLeast = (level: Level, min: Level) => RANK[level] >= RANK[min];

export function areaByKey(key: AreaKey): Area {
  const area = AREAS.find((a) => a.key === key);
  if (!area) throw new Error(`unknown area ${key}`);
  return area;
}

// A level the area offers: unknown values are "none", and a level the area doesn't offer
// rounds down (never up).
export function normalizeLevel(key: AreaKey, value: unknown): Level {
  const { levels } = areaByKey(key);
  if (value !== "view" && value !== "manage") return "none";
  if (levels.includes(value)) return value;
  return value === "manage" && levels.includes("view") ? "view" : "none";
}

// Stored grants (jsonb, or a submitted form) as levels per area. Unknown areas are dropped and
// bad levels are "none"; areas missing from the input are left out.
export function parseGrants(raw: unknown): Partial<Access> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Access> = {};
  for (const area of AREAS) {
    if (area.key in raw)
      out[area.key] = normalizeLevel(area.key, (raw as Record<string, unknown>)[area.key]);
  }
  return out;
}

// A role's access. A built-in nobody has customized gets its defaults. A saved role (a custom
// role, or a customized built-in) lists every area it was saved with; an area added since
// then gives nothing until an Admin reviews it, and is reported in `newAreas`.
export function resolveRole(role: { builtin?: BuiltinRole | null; grants?: unknown }): {
  access: Access;
  newAreas: AreaKey[];
} {
  if (role.builtin && (role.grants === null || role.grants === undefined)) {
    return { access: { ...BUILTIN_DEFAULTS[role.builtin] }, newAreas: [] };
  }
  const saved = parseGrants(role.grants);
  const newAreas = AREAS.map((a) => a.key).filter((k) => !(k in saved));
  return { access: { ...NO_ACCESS, ...saved }, newAreas };
}

// What several roles give together: the highest level in each area.
export function unionAccess(...all: Access[]): Access {
  const out = { ...NO_ACCESS };
  for (const access of all) {
    for (const area of AREAS) {
      if (RANK[access[area.key]] > RANK[out[area.key]]) out[area.key] = access[area.key];
    }
  }
  return out;
}

export type RoleKind = "lead" | "treasurer" | "admin" | "custom";

// A role someone holds, with what the camp stored for it: for Lead or Treasurer the camp's
// customized levels (null: the defaults), for a custom role its levels and whether it's been
// archived (an archived role gives nothing).
export type Assignment = { role: RoleKind; grants: unknown; archived: boolean };

// What a person's roles give together.
export function accessFromAssignments(held: readonly Assignment[]): Access {
  if (held.some((h) => h.role === "admin")) return { ...ADMIN_ACCESS };
  return unionAccess(
    NO_ACCESS,
    ...held.map((h) =>
      h.role === "lead" || h.role === "treasurer"
        ? resolveRole({ builtin: h.role, grants: h.grants }).access
        : h.role === "custom" && !h.archived
          ? resolveRole({ grants: h.grants }).access
          : NO_ACCESS,
    ),
  );
}

// Custom roles (issue #93): at most this many active at once, and never named like a built-in.
export const MAX_CUSTOM_ROLES = 20;
export const RESERVED_ROLE_NAMES = ["member", "lead", "treasurer", "admin"];

// Every area at the level a form asked for (`level_<area>` fields), for storing: each area is
// listed, so an area added later shows up as new on this role.
export function grantsFromForm(get: (name: string) => unknown): Access {
  return Object.fromEntries(
    AREAS.map((a) => [a.key, normalizeLevel(a.key, get(`level_${a.key}`))]),
  ) as Access;
}

// Access from the built-in roles alone, with their defaults (the demo and tests).
export function accessForRoles(roles: readonly string[]): Access {
  if (roles.includes("admin")) return { ...ADMIN_ACCESS };
  return unionAccess(
    NO_ACCESS,
    ...(["lead", "treasurer"] as const)
      .filter((r) => roles.includes(r))
      .map((r) => BUILTIN_DEFAULTS[r]),
  );
}

const featureOn = (area: Area, features?: Partial<Features>) =>
  !area.feature || !features || features[area.feature] !== false;

// Whether `target` can do nothing `actor` can't, in the areas this camp uses: someone may act
// on a person (deactivate them, manage their sign-in) only when that's true.
export function accessWithin(target: Access, actor: Access, features?: Partial<Features>) {
  return AREAS.every((a) => !featureOn(a, features) || RANK[target[a.key]] <= RANK[actor[a.key]]);
}

// React Router's matched-route pattern ("people/:id", "" for the home page) as the path
// pattern the catalog uses ("/people/:id", "/").
export const routePath = (pattern: string) => `/${pattern.replace(/^\/+|\/+$/g, "")}`;

// The area a route belongs to, with the levels it needs for reading and for changes.
export function areaForPattern(
  pattern: string,
): { area: AreaKey; read: Level; write: Level } | null {
  for (const area of AREAS) {
    const need = area.routes[pattern];
    if (need) return { area: area.key, read: need.read ?? "view", write: need.write ?? "manage" };
  }
  return null;
}

function list(items: string[], last = "and") {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

// One sentence: what the role can manage, then view, then which sensitive areas it can't see.
// Areas whose feature is off are left out.
export function accessSummary(access: Access, features?: Partial<Features>): string {
  const shown = AREAS.filter((a) => featureOn(a, features));
  const manage = shown.filter((a) => access[a.key] === "manage").map((a) => a.noun);
  const view = shown.filter((a) => access[a.key] === "view").map((a) => a.noun);
  const hidden = shown
    .filter((a) => SENSITIVE.includes(a.key) && access[a.key] === "none")
    .map((a) => a.noun);
  const parts = [
    manage.length ? `manage ${list(manage)}` : "",
    view.length ? `view ${list(view)}` : "",
  ].filter(Boolean);
  if (!parts.length) return "No extra access beyond members.";
  const can = `Can ${parts.join("; can ")}`;
  return hidden.length ? `${can}. Can't see ${list(hidden, "or")}.` : `${can}.`;
}
