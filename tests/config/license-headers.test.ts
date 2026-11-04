// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every source file names its license and copyright holder (open-source plan 5.2), so a file
// copied out of the repository still says where it came from. A new file needs the two lines
// at the top, after any #! line:
//   // SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
//   // SPDX-License-Identifier: AGPL-3.0-or-later
// (`#` in shell scripts, `/* */` in CSS). Migrations aren't included: they're generated, and
// never edited once merged.

const SOURCE = ["*.ts", "*.tsx", "*.css", "*.sh", "*.js", "*.mjs"];

describe("license headers", () => {
  it("every source file has the SPDX lines", () => {
    const files = execFileSync("git", ["ls-files", "-z", ...SOURCE], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const missing = files.filter((f) => {
      const head = readFileSync(f, "utf8").split("\n", 4).join("\n");
      return !(
        head.includes("SPDX-FileCopyrightText: ") &&
        head.includes("SPDX-License-Identifier: AGPL-3.0-or-later")
      );
    });
    expect(missing).toEqual([]);
  });

  it("the LICENSE is the AGPL's text", () => {
    const license = readFileSync("LICENSE", "utf8");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
  });
});
