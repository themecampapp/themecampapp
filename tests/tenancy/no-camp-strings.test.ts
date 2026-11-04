// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

// R19: the app is every camp's, so no camp's name or in-jokes are built into it. Camp wording
// comes from camp settings, and guides are each camp's own (in the database). The general
// starter guides and the pilot agreement in content/ are checked too.
const ROOTS = ["app", "workers", "public", "content"];
const TEXT = new Set([".ts", ".tsx", ".css", ".html", ".txt", ".json", ".svg", ".md"]);
const BANNED = /yellow[\s_-]?balloon|\bsober\b|baboon/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return TEXT.has(extname(name)) ? [path] : [];
  });
}

describe("camp-specific wording", () => {
  it("isn't built into the app", () => {
    const hits = ROOTS.flatMap(files).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) => (BANNED.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it("doesn't use one camp's look as the default (issue #67)", () => {
    // Yellow Balloon's gold and its balloon mark were the defaults; YB now has them as its own
    // accent and logo. Every camp without its own gets the neutral accent and its initial.
    const YB_LOOK = /#e8b931|#f5d76e|#fff4c1|\bBalloon\b|55% 55% 45% 45%/i;
    const hits = ["app", "workers", "public"].flatMap(files).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) => (YB_LOOK.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
    );
    // The schema's note on how Yellow Balloon was set up is history, not a look.
    expect(hits.filter((h) => !h.startsWith("app/db/schema.ts"))).toEqual([]);
  });

  it("doesn't build the product's name into the app (open-source plan 3.5)", () => {
    // The name is each instance's (config product.name, PRODUCT_NAME). Comments may name the
    // project; nothing a person sees may. The hosted service's own legal pages say it on
    // purpose (they're Kline Technology LLC's, in legal/hosted), so legal/ isn't checked here.
    const code = ["app", "workers", "platform/app", "platform/workers"]
      .flatMap(files)
      .filter((p) => /\.(ts|tsx)$/.test(p));
    const guides = ["content/admin-guide.md", ...files("content/starter-guides")];
    const comment = /^\s*(\/\/|\*|\/\*)/;
    const hits = [...code, ...guides].flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          line.includes("Theme Camp App") && !(path.endsWith(".md") ? false : comment.test(line))
            ? [`${path}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
  });

  it("left the stylesheet's theme in place", () => {
    // Removing a camp's wording once emptied app/app.css and nothing failed.
    const css = readFileSync("app/app.css", "utf8");
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toMatch(/@theme \{[^}]*--color-gold:/);
  });
});
