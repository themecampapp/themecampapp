// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campSettings, memberRole } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// The Admin guide (content/admin-guide.md) on the Admin pages: Admins only, with every link in
// it going somewhere that exists.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  // Every feature on, so every page the guide links to exists.
  await t.db.update(campSettings).set({
    featureSaps: true,
    featureVolunteer: true,
    featureMailing: true,
  });
  for (const [key, roles] of [
    ["admin", ["admin"]],
    ["lead", ["lead"]],
  ] as const) {
    const p = await invitePerson(t, `${key}@example.com`, { legalName: `${key} Person` });
    for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[key] = await signIn(w, `${key}@example.com`);
  }
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const page = async (path: string, who = "admin") => {
  const res = await w.fetch(get(path, cookie[who]));
  return { status: res.status, html: await res.text() };
};

describe("the Admin guide", () => {
  it("is a tab on the Admin pages, covering each of them", async () => {
    expect((await page("/admin")).html).toContain('href="/admin/guide"');
    const { status, html } = await page("/admin/guide");
    expect(status).toBe(200);
    for (const heading of [
      "Getting started",
      "Your camp’s look and details",
      "Features",
      "The words members see",
      "Roles and people",
      "Seasons",
      "Support and your camp’s data",
    ]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
  });

  it("fills in the Discord and site links, leaving no placeholders", async () => {
    const { html } = await page("/admin/guide");
    expect(html).toContain('href="https://discord.gg/support-test"');
    expect(html).toContain('href="https://themecamp.test/legal/privacy"');
    expect(html).toContain("hello@themecamp.test");
    const article = html.slice(html.indexOf("<article"), html.indexOf("</article>"));
    expect(article).not.toMatch(/\{(discord|site|contact|product)\}/);
  });

  it("links only to pages that exist", async () => {
    const { html } = await page("/admin/guide");
    const article = html.slice(html.indexOf("<article"), html.indexOf("</article>"));
    const links = [...new Set([...article.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]))];
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      expect((await page(link)).status, link).toBe(200);
    }
  });

  it("shows the running version, from package.json (open-source plan 6.1)", async () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect((await page("/admin/guide")).html).toContain(`version ${version}`);
  });

  it("is for Admins only", async () => {
    expect((await page("/admin/guide", "lead")).status).toBe(403);
  });
});
