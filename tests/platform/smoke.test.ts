// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the built platform bundle in workerd, as tests/helpers/worker.ts does for camps.
const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
const DOMAIN = "themecamp.test";

function bundleModules() {
  const files = (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(ROOT, f));
  files.sort((a, b) => Number(b.endsWith("/index.js")) - Number(a.endsWith("/index.js")));
  return files.map((path) => ({ type: "ESModule" as const, path, contents: undefined }));
}

let mf: Miniflare;
const get = (url: string) => mf.dispatchFetch(url, { redirect: "manual" });

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: bundleModules(),
      modulesRoot: ROOT,
      compatibilityDate: "2026-09-23",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        PLATFORM_DOMAIN: DOMAIN,
        PRODUCT_NAME: "Theme Camp App",
        LEGAL_DIR: "hosted",
        CONSOLE: "true",
        PILOT_AGREEMENT: "true",
      },
      outboundService: () => new Response("blocked in tests", { status: 599 }),
    }),
  );
  await mf.ready;
});
afterAll(() => mf.dispose());

describe("platform Worker", () => {
  it("serves the public page on the apex, with the security headers", async () => {
    const res = await get(`https://${DOMAIN}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Theme Camp App");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("redirects www to the apex, keeping the path", async () => {
    const res = await get(`https://www.${DOMAIN}/legal?x=1`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`https://${DOMAIN}/legal?x=1`);
  });

  it("refuses the console on ops without Access configured or a token", async () => {
    const res = await get(`https://ops.${DOMAIN}/ops`);
    expect(res.status).toBe(403);
    await res.text();
    const other = await get(`https://ops.${DOMAIN}/anything-else`);
    expect(other.status).toBe(404);
    await other.text();
  });

  it("refuses camp hosts and unknown hosts", async () => {
    for (const host of [`yellowballoon.${DOMAIN}`, "evil.example", `x.ops.${DOMAIN}`]) {
      const res = await get(`https://${host}/`);
      expect(res.status).toBe(404);
      await res.text();
    }
  });
});
