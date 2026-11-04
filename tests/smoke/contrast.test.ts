// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { btn } from "~/components/ui";
import { accentPalette } from "~/lib/camp";
import { contrastRatio, readableAccent } from "~/lib/contrast";

// Small error and danger text must be readable: WCAG AA 4.5:1 on every light background the
// app uses (Lead workspace plan, Unit 3).
const css = readFileSync("app/app.css", "utf8");
const color = (name: string) => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  if (!m) throw new Error(`--color-${name} not found`);
  return m[1];
};

describe("the default accent (issue #67)", () => {
  it("is light enough for dark text, like any camp's accent must be", () => {
    expect(readableAccent(color("gold"))).toBe(true);
    expect(contrastRatio(color("gold"), color("night"))).toBeGreaterThanOrEqual(4.5);
  });

  it("mixes its lighter shades the same way as a camp's own accent", () => {
    const mixed = accentPalette("var(--color-gold)");
    for (const shade of ["gold-light", "gold-glow"] as const) {
      const m = new RegExp(`--color-${shade}:\\s*([^;]+);`).exec(css);
      expect(m?.[1].trim(), shade).toBe(mixed[`--color-${shade}`]);
    }
  });
});

describe("coral text", () => {
  it("reaches 4.5:1 on white, warm white and dust pale", () => {
    for (const bg of ["#ffffff", color("warm-white"), color("dust-pale")]) {
      expect(contrastRatio(color("coral-ink"), bg), bg).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is what danger buttons use, with a visible focus ring", () => {
    expect(btn.danger).toContain("text-coral-ink");
    expect(btn.danger).toContain("focus-visible:outline");
  });

  it("isn't the old, too-light coral on text anywhere", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync("grep -rnE 'text-coral([^-]|$)' app || true", {
      encoding: "utf8",
    }).trim();
    expect(hits).toBe("");
  });
});
