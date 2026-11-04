// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Issue #75: Theme Camp App's own "TCA" icon on the camp sites and the platform's, in place of
// React Router's default. Open-source plan 3.5: every icon folder (icons/<dir>, the TCA icon in
// icons/hosted) has both files at the right sizes; tests/config/instance-icon.test.ts serves them.
const ico = (path: string) => {
  const b = readFileSync(path);
  return {
    reserved: b.readUInt16LE(0),
    type: b.readUInt16LE(2),
    sizes: Array.from({ length: b.readUInt16LE(4) }, (_, i) => b.readUInt8(6 + 16 * i)),
  };
};

describe("the favicon", () => {
  it.each(["icons/hosted", "icons/default"])("%s has an icon at 16, 32 and 48 pixels", (dir) => {
    expect(ico(`${dir}/favicon.ico`)).toEqual({ reserved: 0, type: 1, sizes: [16, 32, 48] });
    const png = readFileSync(`${dir}/apple-touch-icon.png`);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(180); // width
  });

  it.each(["app/root.tsx", "platform/app/root.tsx"])("is linked from %s", (path) => {
    const root = readFileSync(path, "utf8");
    expect(root).toContain('rel: "icon", href: "/favicon.ico"');
    expect(root).toContain('rel: "apple-touch-icon", href: "/apple-touch-icon.png"');
  });
});
