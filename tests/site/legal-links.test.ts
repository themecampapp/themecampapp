// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campSettings, guide } from "~/db/schema";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Theme Camp App's Terms, Privacy Policy and data-handling page are linked from every page of
// a camp's site, signed in or not; and the company behind it is named only where it's a party
// (issue #57).

let t: TestDb;
let w: TestWorker;
let member: string;
const LEGAL = `https://${APP_HOST_SUFFIX}/legal`;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  await t.db.update(campSettings).set({ featureJoin: true });
  await t.db.insert(guide).values({
    slug: "about",
    title: "About camp",
    body: "Hello.",
    visibility: "public",
    published: true,
  });
  await invitePerson(t, "mo@example.com", { legalName: "Mo Member" });
  member = await signIn(w, "mo@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const links = (html: string) =>
  ["terms", "privacy", "data-handling"].every((d) => html.includes(`href="${LEGAL}/${d}"`));

describe("the legal links", () => {
  it("are on pages for people who aren't signed in", async () => {
    for (const path of ["/sign-in", "/join", "/guides", "/guides/about"]) {
      const html = await (await w.fetch(get(path))).text();
      expect(links(html), path).toBe(true);
    }
    // A page that doesn't exist: no route matched, so the camp's data (and the instance's
    // domain) isn't loaded. Rather than guess a hosted address, it shows no legal links
    // (open-source plan 2.4).
    const missing = await (await w.fetch(get("/no-such-page"))).text();
    expect(missing).not.toContain("/legal/terms");
    expect(missing).not.toContain("themecamp.app");
  });

  it("are in the signed-in footer, once", async () => {
    const html = await (await w.fetch(get("/", member))).text();
    expect(links(html)).toBe(true);
    expect(html.split(`href="${LEGAL}/terms"`).length - 1).toBe(1);
  });

  it("carry Burning Man's disclaimer word for word", async () => {
    const html = await (await w.fetch(get("/", member))).text();
    expect(html).toContain(
      "This app is not affiliated, endorsed, or verified by Burning Man Project.",
    );
  });

  it("don't name the company in the privacy notice", async () => {
    const html = await (await w.fetch(get("/", member))).text();
    expect(html).toContain("Theme Camp App hosts the site.");
    expect(html).not.toContain("Kline");
  });
});

describe("the company's name (issue #57)", () => {
  // Only the documents where it's a party may name it: the Terms, the Privacy Policy and the
  // pilot agreement (a contract). Everywhere else it's "Theme Camp App".
  const ALLOWED = new Set([
    "legal/hosted/terms.md",
    "legal/hosted/privacy.md",
    "legal/hosted/pilot-agreement.md",
  ]);
  const TEXT = new Set([".ts", ".tsx", ".md", ".html", ".json", ".css", ".txt"]);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === "build") return [];
      if (statSync(path).isDirectory()) return files(path);
      return TEXT.has(extname(name)) ? [path] : [];
    });

  it("isn't in the app, the platform or the content outside those documents", () => {
    const hits = ["app", "platform/app", "content", "workers"]
      .flatMap(files)
      .filter((path) => !ALLOWED.has(path) && /kline technology/i.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });
});
