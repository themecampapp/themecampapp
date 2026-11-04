// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileInput } from "~/components/ui";

// Issue #88: the base styles strip a file input's "Choose file" button down to plain text, so
// every file input uses the shared fileInput style, which draws it as a button.
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });

describe("file inputs", () => {
  it("draw their Choose file part as a button", () => {
    expect(fileInput).toMatch(/file:border/);
    expect(fileInput).toMatch(/file:rounded-lg/);
    expect(fileInput).toMatch(/file:font-semibold/);
  });

  it("all use the shared style", () => {
    const inputs = ["app", "platform/app"].flatMap(files).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/<input\b[^>]*?type="file"[^>]*?>/gs)].map((m) => ({
        path,
        tag: m[0],
      })),
    );
    expect(inputs.length).toBeGreaterThanOrEqual(4);
    for (const { path, tag } of inputs) expect(tag, path).toMatch(/className=\{fileInput\}/);
  });
});
