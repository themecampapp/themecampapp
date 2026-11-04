// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// R71, R49, R17: the public site on the platform's apex: the landing page and the legal drafts.
const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
const DOMAIN = "themecamp.test";

let mf: Miniflare;
const page = async (path: string) => {
  const res = await mf.dispatchFetch(`https://${DOMAIN}${path}`, { redirect: "manual" });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  const files = (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(ROOT, f));
  files.sort((a, b) => Number(b.endsWith("/index.js")) - Number(a.endsWith("/index.js")));
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: files.map((path) => ({ type: "ESModule" as const, path, contents: undefined })),
      modulesRoot: ROOT,
      compatibilityDate: "2026-09-23",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        PLATFORM_DOMAIN: DOMAIN,
        CONTACT_EMAIL: "hello@themecamp.test",
        PRODUCT_NAME: "Theme Camp App",
        LEGAL_DIR: "hosted",
        PILOT_AGREEMENT: "true",
        SIGNUP_PAGE: "true",
        SOURCE_URL: "https://code.example.org/themecampapp",
      },
      outboundService: () => new Response("blocked in tests", { status: 599 }),
    }),
  );
  await mf.ready;
});
afterAll(() => mf.dispose());

describe("the public site", () => {
  it("explains the pilot, links the demo, the sign-up page and the legal pages", async () => {
    const { status, text } = await page("/");
    expect(status).toBe(200);
    expect(text).toContain("A small pilot");
    // Issue #99: free for good, optional donations, open source (now linked).
    expect(text).toContain("Free for camps, for good");
    expect(text).toContain("Giving will always be optional");
    expect(text).toMatch(/The code is <a href="https:\/\/code\.example\.org\/themecampapp"[^>]*>open source<\/a>/);
    expect(text).toContain('href="/signup"'); // issue #73
    expect(text).toContain(`href="https://demo.${DOMAIN}"`);
    expect(text).toContain("mailto:hello@themecamp.test");
    for (const doc of ["terms", "privacy", "data-handling", "pilot-agreement"]) {
      expect(text).toContain(`href="/legal/${doc}"`);
    }
    expect(text).toContain(
      "This app is not affiliated, endorsed, or verified by Burning Man Project.",
    );
    // Issue #57: the company is named only where it's a party (Terms, Privacy, the agreement).
    expect(text).not.toContain("Kline Technology");
  });

  it("publishes the legal drafts, naming the operator where it's a party", async () => {
    for (const [doc, title, named] of [
      ["terms", "Terms of Service", true],
      ["privacy", "Privacy Policy", true],
      ["data-handling", "How we handle data", false],
      ["pilot-agreement", "Pilot agreement", true],
    ] as const) {
      const { status, text } = await page(`/legal/${doc}`);
      expect(status, doc).toBe(200);
      expect(text, doc).toContain(`<h1 class="text-3xl font-bold">${title}</h1>`);
      expect(text.includes("Kline Technology LLC"), doc).toBe(named);
      expect(text, doc).not.toContain("{contact}");
      // Every legal page links to the others.
      for (const other of ["terms", "privacy", "data-handling", "pilot-agreement"]) {
        expect(text, `${doc} → ${other}`).toContain(`href="/legal/${other}"`);
      }
    }
    const privacy = (await page("/legal/privacy")).text;
    expect(privacy).toContain("hello@themecamp.test");
    // R50: the roles.
    expect(privacy).toContain("decides what it keeps about its people");
    expect(privacy).toContain("unless one of its Admins grants us support access");
  });

  it("has no other legal pages", async () => {
    for (const doc of ["cookies", "..%2Fpilot-agreement", "TERMS"]) {
      expect((await page(`/legal/${doc}`)).status, doc).toBe(404);
    }
  });
});
