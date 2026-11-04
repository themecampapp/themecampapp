// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogSection } from "../../scripts/changelog-section";
import { parseVersion, versionsBetween } from "../../scripts/upgrade";

// Open-source plan 6.1, 6.2 and 4.3: versions, the changelog, and reading it when upgrading.

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something new.

### Migrations

- None

## [1.2.0] - 2027-02-01

### Fixed

- A bug.

### Migrations

- \`0040_x\`

### Upgrade notes

- Set NEW_SECRET.

## [1.1.0] - 2027-01-01

### Migrations

- None

## [1.0.0] - 2026-12-01

### Migrations

- None
`;

describe("the changelog", () => {
  it("gives one version's section, without its heading or the next one's", () => {
    const section = changelogSection(CHANGELOG, "1.2.0") ?? "";
    expect(section.startsWith("### Fixed")).toBe(true);
    expect(section).toContain("Set NEW_SECRET.");
    expect(section).not.toContain("1.1.0");
    expect(changelogSection(CHANGELOG, "1.0.0")).toBe("### Migrations\n\n- None");
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("lists the releases between two versions, newest first", () => {
    const from = parseVersion("1.0.0");
    const to = parseVersion("v1.2.0");
    if (!from || !to) throw new Error("unparsed");
    expect(versionsBetween(CHANGELOG, from, to)).toEqual(["1.2.0", "1.1.0"]);
    expect(parseVersion("1.2")).toBeNull();
  });

  it("has an Unreleased section with its Migrations, and package.json has a version", () => {
    const real = readFileSync("CHANGELOG.md", "utf8");
    const unreleased = changelogSection(real, "Unreleased") ?? "";
    expect(unreleased).toMatch(/^### Migrations$/m);
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(parseVersion(version)).not.toBeNull();
  });
});
