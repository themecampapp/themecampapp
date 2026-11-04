// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  ADMIN_ACCESS,
  AREAS,
  accessForRoles,
  accessSummary,
  accessWithin,
  areaForPattern,
  BUILTIN_DEFAULTS,
  NO_ACCESS,
  normalizeLevel,
  parseGrants,
  resolveRole,
  routePath,
  STARTING_POINTS,
  unionAccess,
} from "~/lib/permissions";
import routes from "../../app/routes";

const start = (key: string) => {
  const s = STARTING_POINTS.find((p) => p.key === key);
  if (!s) throw new Error(key);
  return s.access;
};

describe("the area catalog (issue #93)", () => {
  it("gives Lead and Treasurer exactly their pre-#93 abilities", () => {
    expect(BUILTIN_DEFAULTS.lead.dues).toBe("none");
    expect(BUILTIN_DEFAULTS.lead.people).toBe("manage");
    expect(BUILTIN_DEFAULTS.lead.private).toBe("view");
    expect(Object.values(BUILTIN_DEFAULTS.treasurer).filter((l) => l !== "none")).toEqual([
      "manage",
    ]);
    expect(BUILTIN_DEFAULTS.treasurer.dues).toBe("manage");
  });

  it("combines Lead and Treasurer into Lead's access plus managing dues", () => {
    expect(unionAccess(BUILTIN_DEFAULTS.lead, BUILTIN_DEFAULTS.treasurer)).toEqual({
      ...BUILTIN_DEFAULTS.lead,
      dues: "manage",
    });
    expect(accessForRoles(["lead", "treasurer"])).toEqual(
      unionAccess(BUILTIN_DEFAULTS.lead, BUILTIN_DEFAULTS.treasurer),
    );
    expect(accessForRoles(["admin"])).toEqual(ADMIN_ACCESS);
    expect(accessForRoles([])).toEqual(NO_ACCESS);
  });

  it("drops unknown areas and bad levels instead of throwing", () => {
    expect(parseGrants({ people: "owner", dues: "view", nonsense: "manage" })).toEqual({
      people: "none",
      dues: "view",
    });
    expect(parseGrants(null)).toEqual({});
    expect(parseGrants("manage")).toEqual({});
  });

  it("rounds a level an area doesn't offer down, never up", () => {
    expect(normalizeLevel("announcements", "view")).toBe("none");
    expect(normalizeLevel("private", "manage")).toBe("view");
    expect(normalizeLevel("people", "manage")).toBe("manage");
  });

  it("gives an un-customized built-in its defaults, and a saved role nothing in new areas", () => {
    expect(resolveRole({ builtin: "lead", grants: null })).toEqual({
      access: BUILTIN_DEFAULTS.lead,
      newAreas: [],
    });
    const { tickets: _, ...savedBeforeTickets } = BUILTIN_DEFAULTS.lead;
    const saved = resolveRole({ builtin: "lead", grants: savedBeforeTickets });
    expect(saved.access.tickets).toBe("none");
    expect(saved.newAreas).toEqual(["tickets"]);
    expect(resolveRole({ grants: { dues: "view" } }).access).toEqual({
      ...NO_ACCESS,
      dues: "view",
    });
  });

  it("compares access only in the areas the camp uses", () => {
    const leadAndTreasurer = accessForRoles(["lead", "treasurer"]);
    expect(accessWithin(BUILTIN_DEFAULTS.lead, leadAndTreasurer)).toBe(true);
    expect(accessWithin(leadAndTreasurer, BUILTIN_DEFAULTS.lead)).toBe(false);
    expect(accessWithin(NO_ACCESS, NO_ACCESS)).toBe(true);
    const noSaps = { ...BUILTIN_DEFAULTS.lead, saps: "none" as const };
    expect(accessWithin(BUILTIN_DEFAULTS.lead, noSaps)).toBe(false);
    expect(accessWithin(BUILTIN_DEFAULTS.lead, noSaps, { saps: false })).toBe(true);
  });

  it("can build each example role from the issue", () => {
    expect(accessSummary(start("registrar"))).toBe(
      "Can manage people and inquiries. Can't see private details and notes or dues.",
    );
    expect(accessSummary(start("tickets"))).toBe(
      "Can manage tickets. Can't see private details and notes or dues.",
    );
    expect(accessSummary(start("dues_viewer"))).toBe(
      "Can view dues. Can't see private details and notes.",
    );
    expect(accessSummary(NO_ACCESS)).toBe("No extra access beyond members.");
  });

  it("leaves switched-off features out of a summary", () => {
    expect(accessSummary(BUILTIN_DEFAULTS.treasurer, { dues: false })).toBe(
      "No extra access beyond members.",
    );
    expect(accessSummary(BUILTIN_DEFAULTS.lead, { saps: false, volunteer: false })).not.toContain(
      "SAPs",
    );
  });

  it("reads React Router's matched-route patterns as catalog paths", () => {
    expect(routePath("people/:id")).toBe("/people/:id");
    expect(routePath("")).toBe("/");
    expect(routePath("/dues/")).toBe("/dues");
  });

  it("finds a route's area and the levels it needs", () => {
    expect(areaForPattern("/people/:id/rsvp")).toEqual({
      area: "roster",
      read: "view",
      write: "manage",
    });
    expect(areaForPattern("/dues")?.area).toBe("dues");
    expect(areaForPattern("/queue")).toEqual({ area: "people", read: "manage", write: "manage" });
    expect(areaForPattern("/tickets/request")).toBeNull();
    expect(areaForPattern("/profile")).toBeNull();
  });

  it("names only routes that exist", () => {
    type R = { path?: string; children?: R[] };
    const paths = new Set<string>();
    const walk = (rs: R[], prefix: string) => {
      for (const r of rs) {
        const p = r.path ? `${prefix}/${r.path}`.replace(/\/+/g, "/") : prefix || "/";
        paths.add(p);
        if (r.children) walk(r.children, r.path ? p : prefix);
      }
    };
    walk(routes as R[], "");
    for (const area of AREAS) {
      for (const pattern of Object.keys(area.routes)) expect(paths).toContain(pattern);
    }
  });
});
