// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";

// Runs scheduled jobs one after another. Each runs on its own: one failing doesn't stop the
// rest, and its error goes to the Worker's logs.
export type Job<E> = { name: string; run: (sql: postgres.Sql, env: E) => Promise<unknown> };

export async function runJobs<E>(sql: postgres.Sql, env: E, jobs: Job<E>[]) {
  const results: Array<{ name: string; ok: boolean; result?: unknown; error?: string }> = [];
  for (const job of jobs) {
    try {
      results.push({ name: job.name, ok: true, result: await job.run(sql, env) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`job ${job.name} failed: ${error}`);
      results.push({ name: job.name, ok: false, error });
    }
  }
  console.log(JSON.stringify({ jobs: results }));
  return results;
}
