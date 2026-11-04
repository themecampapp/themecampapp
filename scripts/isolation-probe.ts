// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { isolationProblems } from "../platform/app/lib/isolation.server";

// The isolation probe from the command line, as a role under row-level security: app_probe
// (the daily job), or app_runtime. The checks are in platform/app/lib/isolation.server.ts.
// Read-only.
//   PROBE_DATABASE_URL=<app_probe URL> [PROBE_CAMP_ID=<uuid>] tsx scripts/isolation-probe.ts

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.PROBE_DATABASE_URL;
  const campId = process.env.PROBE_CAMP_ID;
  if (!url) {
    console.error(
      "PROBE_DATABASE_URL (app_probe, or another role under row-level security) is required",
    );
    process.exit(1);
  }
  if (campId && !/^[0-9a-f-]{36}$/.test(campId)) {
    console.error("PROBE_CAMP_ID must be a camp's uuid");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const problems = await isolationProblems(sql, campId);
    if (problems.length) {
      console.error(`ISOLATION PROBLEMS:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log("isolation holds for every camp table");
    }
  } finally {
    await sql.end();
  }
}
