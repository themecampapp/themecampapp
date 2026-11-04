// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The season roster's filters, presets, sorts and columns (Lead workspace plan, Unit 5),
// shared by the page and the server. Everything lives in the URL, so a view can be bookmarked
// and Back works. Unknown values are ignored; dues values are only honoured for Treasurers
// (the server drops them for anyone else).

export const RSVP = ["going", "leaning_yes", "leaning_no", "not_going", "none"] as const;
export const TICKET = ["requested", "elsewhere", "missing"] as const;
export const SAP = ["requested", "pending", "approved", "denied"] as const;
export const VOLUNTEER = ["none", "some"] as const;
export const DUES = ["unpaid", "paid", "waived"] as const;
export const SORTS = ["name", "arrival", "rsvp", "years"] as const;
export const COLUMNS = ["rsvp", "dates", "ticket", "sap", "volunteer", "years", "dues"] as const;

export type Rsvp = (typeof RSVP)[number];
export type Column = (typeof COLUMNS)[number];

export type Filters = {
  q: string;
  rsvp: Rsvp | null;
  ticket: (typeof TICKET)[number] | null;
  sap: (typeof SAP)[number] | null;
  volunteer: (typeof VOLUNTEER)[number] | null;
  dues: (typeof DUES)[number] | null;
  generator: boolean;
  coming: boolean; // Going or Leaning yes
  sort: (typeof SORTS)[number];
  groupBy: "arrival" | null;
};

export const PRESETS = [
  { key: "everyone", label: "Everyone" },
  { key: "coming", label: "Everyone coming" },
  { key: "no-rsvp", label: "No RSVP" },
  { key: "missing-ticket", label: "No ticket request" },
  { key: "arrivals", label: "Arrivals" },
  { key: "pending-sap", label: "SAP to decide" },
  { key: "sap", label: "SAP requests" },
  { key: "generators", label: "Generators" },
  { key: "no-volunteer", label: "No job" },
  { key: "unpaid", label: "Dues unpaid", treasurer: true },
] as const;
export type Preset = (typeof PRESETS)[number]["key"];

const PRESET_FILTERS: Record<Preset, Partial<Filters>> = {
  everyone: {},
  coming: { coming: true },
  "no-rsvp": { rsvp: "none" },
  "missing-ticket": { ticket: "missing" },
  arrivals: { coming: true, sort: "arrival", groupBy: "arrival" },
  "pending-sap": { sap: "pending" },
  sap: { coming: true, sap: "requested" },
  generators: { coming: true, generator: true },
  "no-volunteer": { coming: true, volunteer: "none" },
  unpaid: { coming: true, dues: "unpaid" },
};

// The roster's old ?view= values, so bookmarks and older links keep working.
const OLD_VIEWS: Record<string, { preset?: Preset; rsvp?: Rsvp }> = {
  all: { preset: "everyone" },
  going: { rsvp: "going" },
  leaning_yes: { rsvp: "leaning_yes" },
  leaning_no: { rsvp: "leaning_no" },
  not_going: { rsvp: "not_going" },
  arrivals: { preset: "arrivals" },
  early: { preset: "sap" },
  generators: { preset: "generators" },
  missing: { preset: "no-rsvp" },
  unpaid: { preset: "unpaid" },
};

// The new address for an old ?view= link (null when there's nothing to change).
export function upgradeOldView(params: URLSearchParams): string | null {
  const old = OLD_VIEWS[params.get("view") ?? ""];
  if (!params.has("view")) return null;
  const next = new URLSearchParams(params);
  next.delete("view");
  if (old?.preset && old.preset !== "everyone") next.set("preset", old.preset);
  if (old?.rsvp) next.set("rsvp", old.rsvp);
  const s = next.toString();
  return `/roster${s ? `?${s}` : ""}`;
}

const pick = <T extends string>(list: readonly T[], v: string | null): T | null =>
  v && (list as readonly string[]).includes(v) ? (v as T) : null;

export type RosterQuery = {
  preset: Preset;
  filters: Filters;
  columns: Column[];
};

export const DEFAULT_COLUMNS: Column[] = ["rsvp", "dates", "ticket", "sap", "volunteer"];

// Reads the URL. `treasurer` decides whether dues may be filtered on or shown at all.
export function readRosterQuery(params: URLSearchParams, treasurer: boolean): RosterQuery {
  const old = OLD_VIEWS[params.get("view") ?? ""];
  let preset = pick(
    PRESETS.map((p) => p.key),
    params.get("preset") ?? old?.preset ?? null,
  ) as Preset | null;
  if (preset === "unpaid" && !treasurer) preset = null;
  preset ??= "everyone";
  const base: Filters = {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    rsvp: null,
    ticket: null,
    sap: null,
    volunteer: null,
    dues: null,
    generator: false,
    coming: false,
    sort: "name",
    groupBy: null,
    ...PRESET_FILTERS[preset],
  };
  const filters: Filters = {
    ...base,
    rsvp: pick(RSVP, params.get("rsvp")) ?? old?.rsvp ?? base.rsvp,
    ticket: pick(TICKET, params.get("ticket")) ?? base.ticket,
    sap: pick(SAP, params.get("sap")) ?? base.sap,
    volunteer: pick(VOLUNTEER, params.get("volunteer")) ?? base.volunteer,
    dues: treasurer ? (pick(DUES, params.get("dues")) ?? base.dues) : null,
    sort: pick(SORTS, params.get("sort")) ?? base.sort,
  };
  // `cols=a,b` in links, or one `col` per ticked box from the column chooser's form.
  const asked = [...(params.get("cols") ?? "").split(","), ...params.getAll("col")]
    .map((c) => pick(COLUMNS, c))
    .filter((c): c is Column => c !== null);
  const columns = (asked.length ? asked : DEFAULT_COLUMNS).filter((c) => c !== "dues" || treasurer);
  return { preset, filters, columns };
}

// The query string for a view, keeping only what differs from its preset (for links).
export function rosterSearch(
  next: { preset?: Preset; q?: string; sort?: string; cols?: Column[] } & Record<string, unknown>,
) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    out.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

export const RSVP_LABEL: Record<Rsvp, string> = {
  going: "Going",
  leaning_yes: "Leaning yes",
  leaning_no: "Leaning no",
  not_going: "Not going",
  none: "No RSVP",
};

export const COLUMN_LABEL: Record<Column, string> = {
  rsvp: "RSVP",
  dates: "Arrival → departure",
  ticket: "Ticket request",
  sap: "SAP",
  volunteer: "Volunteer",
  years: "Years camped",
  dues: "Dues",
};

// "Sat, Aug 22" for an ISO date (a calendar day: no time zone shifts).
export function formatDay(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
