// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execSync } from "node:child_process";
import { readConfig, writeWrangler } from "../../scripts/config-to-wrangler";

// Request-level tests import the real production bundles (camp and platform Workers), so
// build both once per run, from the local instance's config (never a hosted one).
export default function setup() {
  writeWrangler(".", [readConfig("local")]);
  execSync("npx react-router build", { stdio: "ignore" });
  execSync("npx react-router build platform", { stdio: "ignore" });
}
