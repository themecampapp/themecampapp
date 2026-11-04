// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfig, wranglerConfig } from "../../scripts/config-to-wrangler";
import { ico, iconSvg } from "../../scripts/make-icon";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { startPlatform } from "../helpers/platform";
import { get, startWorker, type TestWorker } from "../helpers/worker";

// Open-source plan 3.5: each instance's favicon and apple-touch icon come from icons/<dir>/ (the
// config's product.icon). The hosted service's is the TCA icon.

const file = (dir: string, name: string) =>
  new Uint8Array(readFileSync(new URL(`../../icons/${dir}/${name}`, import.meta.url)));
const bytes = async (res: { arrayBuffer(): Promise<ArrayBuffer> }) =>
  new Uint8Array(await res.arrayBuffer());

describe("the config", () => {
  it("gives the hosted service the TCA icon, and the example the neutral one", () => {
    expect(wranglerConfig("camps", [readConfig("hosted")]).vars.ICON_DIR).toBe("hosted");
    expect(wranglerConfig("platform", [readConfig("hosted")]).vars.ICON_DIR).toBe("hosted");
    expect(wranglerConfig("platform", [readConfig("example")]).vars.ICON_DIR).toBe("default");
  });
});

describe("scripts/make-icon.ts", () => {
  it("draws initials, escaped, or the tent", () => {
    expect(iconSvg({ initials: "ec" }, 32, "#000", "#fff")).toContain(">EC</text>");
    expect(iconSvg({ initials: "A&" }, 32, "#000", "#fff")).toContain("A&amp;");
    expect(iconSvg({ tent: true }, 180, "#000", "#fff")).toContain("<path");
  });

  it("writes an .ico that lists each PNG at its offset", () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.from([4, 5]);
    const out = ico([
      { size: 16, png: a },
      { size: 32, png: b },
    ]);
    expect(out.readUInt16LE(2)).toBe(1); // an icon
    expect(out.readUInt16LE(4)).toBe(2); // two images
    expect(out.readUInt8(6)).toBe(16);
    expect(out.readUInt32LE(6 + 8)).toBe(3);
    expect(out.readUInt32LE(6 + 12)).toBe(38);
    expect(out.readUInt32LE(22 + 12)).toBe(41);
    expect([...out.subarray(38)]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("the Workers", () => {
  let t: TestDb;
  let hosted: TestWorker;
  let plain: TestWorker;
  let platform: Awaited<ReturnType<typeof startPlatform>>;
  beforeAll(async () => {
    t = await createTestDb();
    hosted = await startWorker(t);
    plain = await startWorker(t, { ICON_DIR: "default" });
    platform = await startPlatform(t, undefined, { ICON_DIR: "default" });
  });
  afterAll(async () => {
    await platform.dispose();
    await plain.dispose();
    await hosted.dispose();
    await t.drop();
  });

  it("serve the instance's icon on a camp's host, and on hosts that are no camp", async () => {
    const fav = await hosted.fetch(get("/favicon.ico"));
    expect(fav.status).toBe(200);
    expect(fav.headers.get("Content-Type")).toBe("image/x-icon");
    expect(await bytes(fav)).toEqual(file("hosted", "favicon.ico"));
    const touch = await hosted.fetch(
      get("/apple-touch-icon.png", undefined, `https://nocamp.${APP_HOST_SUFFIX}`),
    );
    expect(touch.headers.get("Content-Type")).toBe("image/png");
    expect(await bytes(touch)).toEqual(file("hosted", "apple-touch-icon.png"));
  });

  it("serve another instance's own icon", async () => {
    expect(await bytes(await plain.fetch(get("/favicon.ico")))).toEqual(
      file("default", "favicon.ico"),
    );
    expect(await bytes(await platform.site("/favicon.ico"))).toEqual(
      file("default", "favicon.ico"),
    );
    expect(await bytes(await platform.site("/apple-touch-icon.png"))).toEqual(
      file("default", "apple-touch-icon.png"),
    );
  });

  it("fall back to the neutral icon for a folder that doesn't exist", async () => {
    const w = await startWorker(t, { ICON_DIR: "missing" });
    try {
      expect(await bytes(await w.fetch(get("/favicon.ico")))).toEqual(
        file("default", "favicon.ico"),
      );
    } finally {
      await w.dispose();
    }
  });
});
