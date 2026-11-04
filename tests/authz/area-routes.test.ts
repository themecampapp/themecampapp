// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { assertRouteAccess, type Viewer } from "~/lib/access.server";
import { AREAS, areaForPattern, NO_ACCESS } from "~/lib/permissions";
import routes from "~/routes";

// Issue #93: every page of the Lead tools belongs to an area (app/lib/permissions.ts), and no
// other page does: a member's own pages (their ticket request, their SAP pass) never need one.

type R = { file: string; path?: string; index?: boolean; children?: R[] };
type Page = { file: string; path: string; lead: boolean };

function pages(rs: R[], prefix = "", lead = false): Page[] {
  return rs.flatMap((r) => {
    const path = r.path ? `${prefix}/${r.path}`.replace(/\/+/g, "/") : prefix || "/";
    const inLead = lead || r.file === "routes/_app.lead.tsx";
    const own = r.path || r.index ? [{ file: r.file, path, lead: inLead }] : [];
    return [...own, ...pages(r.children ?? [], r.path ? path : prefix, inLead)];
  });
}

const all = pages(routes as R[]);

describe("areas and routes (issue #93)", () => {
  it("gives every Lead page, and /dues, an area", () => {
    const missing = all
      .filter((p) => p.lead || p.path === "/dues")
      .filter((p) => !areaForPattern(p.path))
      .map((p) => `${p.path} (${p.file})`);
    expect(missing).toEqual([]);
  });

  it("gives no other page an area", () => {
    const extra = all
      .filter((p) => !p.lead && p.path !== "/dues")
      .filter((p) => areaForPattern(p.path))
      .map((p) => `${p.path} (${p.file})`);
    expect(extra).toEqual([]);
  });

  it("finds the member pages that share a Lead page's first segment", () => {
    for (const path of ["/tickets/request", "/saps/pass/:id/pdf", "/volunteer", "/profile"]) {
      expect(all.map((p) => p.path)).toContain(path);
      expect(areaForPattern(path)).toBeNull();
    }
  });
});

// Someone with only View in an area (possible once roles can be edited): they can open the
// area's pages that ask for View, and can't open the ones that ask for Manage, or change
// anything anywhere in it.
describe("View alone (issue #93)", () => {
  const viewer = (area: (typeof AREAS)[number]["key"]): Viewer => ({
    personId: "00000000-0000-4000-8000-000000000001",
    authUserId: "",
    legalName: "Viewer",
    playaName: null,
    access: { ...NO_ACCESS, [area]: "view" },
    roles: [],
  });
  const outcome = (v: Viewer, pattern: string, method: string) => {
    try {
      assertRouteAccess(v, pattern, method);
      return "allowed";
    } catch (e) {
      return (e as { init?: { status?: number } }).init?.status === 403 ? "refused" : "error";
    }
  };

  for (const area of AREAS.filter((a) => a.levels.includes("view"))) {
    it(`in ${area.label}`, () => {
      const v = viewer(area.key);
      for (const [pattern, need] of Object.entries(area.routes)) {
        const read = need.read ?? "view";
        expect(outcome(v, pattern, "GET"), `GET ${pattern}`).toBe(
          read === "view" ? "allowed" : "refused",
        );
        expect(outcome(v, pattern, "POST"), `POST ${pattern}`).toBe("refused");
      }
    });
  }

  it("never lets View in one area open another area's pages", () => {
    const v = viewer("tickets");
    expect(outcome(v, "/people", "GET")).toBe("refused");
    expect(outcome(v, "/dues", "GET")).toBe("refused");
    expect(outcome(v, "/profile", "GET")).toBe("allowed");
  });
});
