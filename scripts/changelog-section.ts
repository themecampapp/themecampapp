// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Prints one version's section of CHANGELOG.md (without its heading), for the release workflow
// and scripts/upgrade.ts. Fails if the version has no section, or the section has no Migrations
// heading: every release says whether it has migrations, even if only "None".
//   npx tsx scripts/changelog-section.ts 1.2.0
import { readFileSync } from "node:fs";

export function changelogSection(text: string, version: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

if (process.argv[1]?.endsWith("changelog-section.ts")) {
  const version = process.argv[2];
  const section = version && changelogSection(readFileSync("CHANGELOG.md", "utf8"), version);
  if (!section) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  if (!/^### Migrations$/m.test(section)) {
    console.error(
      `The ${version} section needs a "### Migrations" heading ("None" if there are none)`,
    );
    process.exit(1);
  }
  console.log(section);
}
