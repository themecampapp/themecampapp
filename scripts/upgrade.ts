// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Before taking a new release into a self-hosted fork (open-source plan 4.3): shows every release's
// notes between the version you run and the one you're moving to, flags migrations and upgrade
// notes, and with --merge merges the release's tag. It changes nothing else: pushing to main then
// deploys staging, and production is deployed as usual. docs/upgrading.md has the whole routine.
//   npx tsx scripts/upgrade.ts v1.2.0 [--remote upstream] [--merge]
// The remote is the canonical repository (git remote add upstream https://github.com/themecampapp/themecampapp).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { changelogSection } from "./changelog-section";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

type Version = [number, number, number];
export function parseVersion(v: string): Version | null {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The released versions in a changelog, newest first, that are newer than `from` and no newer
// than `to`.
export function versionsBetween(changelog: string, from: Version, to: Version): string[] {
  return [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)]
    .map((m) => m[1])
    .filter((v) => {
      const p = parseVersion(v) as Version;
      return compare(p, from) > 0 && compare(p, to) <= 0;
    });
}

// Migration files in a drizzle journal.
const migrations = (journal: string) =>
  (JSON.parse(journal) as { entries: Array<{ tag: string }> }).entries.map((e) => e.tag);

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { remote: { type: "string", default: "upstream" }, merge: { type: "boolean" } },
  });
  const tag = positionals[0];
  const target = tag ? parseVersion(tag) : null;
  if (!tag || !target) {
    console.error("Usage: npx tsx scripts/upgrade.ts v1.2.0 [--remote upstream] [--merge]");
    process.exit(1);
  }
  if (git("status", "--porcelain")) {
    console.error("Commit or stash your changes first.");
    process.exit(1);
  }
  git("fetch", values.remote as string, "--tags");
  const current = parseVersion(
    (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version,
  ) as Version;
  if (compare(target, current) <= 0) {
    console.log(`You're on ${current.join(".")} already; nothing to do.`);
    return;
  }

  const changelog = git("show", `${tag}:CHANGELOG.md`);
  const versions = versionsBetween(changelog, current, target);
  console.log(`From ${current.join(".")} to ${target.join(".")}: ${versions.length} release(s).\n`);
  let notes = false;
  for (const v of versions) {
    const section = changelogSection(changelog, v) as string;
    console.log(`## ${v}\n\n${section}\n`);
    if (/^### Upgrade notes$/m.test(section)) notes = true;
  }

  const before = new Set(migrations(readFileSync("drizzle/meta/_journal.json", "utf8")));
  const added = migrations(git("show", `${tag}:drizzle/meta/_journal.json`)).filter(
    (m) => !before.has(m),
  );
  console.log(
    added.length
      ? `Migrations: ${added.join(", ")}. The deploy takes a snapshot, then runs them before the new code.`
      : "Migrations: none.",
  );
  if (notes) console.log("Upgrade notes above: do what they say, in order, around the deploy.");

  if (values.merge) {
    git("merge", "--no-edit", tag);
    console.log(`\nMerged ${tag}. Push to main to deploy staging, then deploy production.`);
  } else {
    console.log(`\nWhen you're ready: npx tsx scripts/upgrade.ts ${tag} --merge`);
  }
}

if (process.argv[1]?.endsWith("upgrade.ts")) main();
