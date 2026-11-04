// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/setup/build.ts", "tests/setup/roles.ts"],
    testTimeout: 20000,
    // Most files' beforeAll builds a database, starts the Worker and signs people in through
    // it. On GitHub's runners that can pass Vitest's 10-second default (directory.test.ts takes
    // about 9.5s on a quiet runner and timed out on a busy one), so setup gets the same room.
    hookTimeout: 30000,
    // Files in a worker share imported modules instead of re-importing the app, Miniflare and
    // sharp for each one: on CI's 2-core runners that re-import was over half the run. Test
    // data never leaks between files (each has its own database), and stubbed globals (fetch)
    // are put back after every test.
    isolate: false,
    unstubGlobals: true,
    // Each file gets its own Postgres database (and Workers-runtime connections); cap
    // parallelism so a full run stays well under Postgres's 100-connection limit.
    maxWorkers: 4,
  },
});
