// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole } from "~/db/schema";
import routes from "~/routes";
import { APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { fingerprint, seedZulu, type Zulu } from "../helpers/two-camps";
import { invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";
import { MIXED, type Probe, REGISTRY, registryGaps } from "./cross-camp.registry";

// R5: every camp route, aimed at camp B's records by camp A's Admin, finds nothing and
// changes nothing. See cross-camp.registry.ts for the probes.

type RouteNode = { file: string; children?: RouteNode[] };
function routeFiles(nodes: RouteNode[]): string[] {
  return nodes.flatMap((n) => [n.file, ...routeFiles(n.children ?? [])]);
}

describe("the cross-camp registry", () => {
  it("has an entry for every route, and none for routes that don't exist", () => {
    const files = routeFiles(routes as unknown as RouteNode[]);
    expect(registryGaps(files)).toEqual({ missing: [], extra: [] });
  });

  it("would catch a new route added without probes", () => {
    const files = [...routeFiles(routes as unknown as RouteNode[]), "routes/_app.new-page.tsx"];
    expect(registryGaps(files).missing).toEqual(["routes/_app.new-page.tsx"]);
  });

  it("gives every non-layout route at least one probe", () => {
    for (const [file, entry] of Object.entries(REGISTRY)) {
      if (entry === "layout") continue;
      expect(entry.length, file).toBeGreaterThan(0);
    }
  });
});

let t: TestDb;
let w: TestWorker;
let z: Zulu;
let cookie: string;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  // Camp A's Admin, who is also Lead and Treasurer: every page is open to them.
  const admin = await invitePerson(t, "alpha-admin@example.com", { legalName: "Alpha Admin" });
  await t.db
    .insert(memberRole)
    .values(
      (["lead", "treasurer", "admin"] as const).map((role) => ({ personId: admin.id, role })),
    );
  w = await startWorker(t);
  cookie = await signIn(w, "alpha-admin@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

function formBody(form: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
  }
  return body.toString();
}

function request(p: Probe) {
  const headers: Record<string, string> = {};
  if (!p.anonymous) headers.cookie = cookie;
  if (p.method === "POST") {
    headers.origin = APP_URL;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  return new Request(`${APP_URL}${p.path(z)}`, {
    method: p.method ?? "GET",
    headers,
    body: p.method === "POST" ? formBody(p.form?.(z) ?? {}) : undefined,
  });
}

const probes = [
  ...Object.entries(REGISTRY).flatMap(([file, entry]) =>
    entry === "layout" ? [] : entry.map((p) => [`${file} · ${p.name}`, p] as const),
  ),
  ...MIXED.map((p) => [`mixed · ${p.name}`, p] as const),
];

describe("camp A's Admin aimed at camp B", () => {
  it.each(probes)("%s", async (_label, p) => {
    const before = p.method === "POST" ? await fingerprint(t, z.campId) : "";
    const res = await w.fetch(request(p));
    const body = await res.text();

    if (p.status !== undefined) expect(res.status).toBe(p.status);
    else expect(res.status, body.slice(0, 300)).toBeLessThan(500);
    for (const marker of z.markers) {
      expect(body.includes(marker), `response contains camp B's "${marker}"`).toBe(false);
    }
    const location = res.headers.get("Location") ?? "";
    for (const marker of z.markers) expect(location.includes(marker)).toBe(false);

    if (p.method === "POST") expect(await fingerprint(t, z.campId)).toBe(before);
  });
});
