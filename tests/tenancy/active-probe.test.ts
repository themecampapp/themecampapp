// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolationProblems } from "../../platform/app/lib/isolation.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";

let t: TestDb;
let z: Zulu;
let runtime: ReturnType<typeof postgres>;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  runtime = postgres(t.runtimeUrl, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await runtime.end();
  await t.drop();
});

describe("the active isolation probe", () => {
  it("finds nothing wrong with two camps full of data", async () => {
    expect(await isolationProblems(runtime, t.campId)).toEqual([]);
    expect(await isolationProblems(runtime, z.campId)).toEqual([]);
  });

  it("runs as the daily job's read-only role (app_probe)", async () => {
    const url = new URL(t.runtimeUrl);
    url.username = "app_probe";
    const probe = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      expect(await isolationProblems(probe, t.campId)).toEqual([]);
    } finally {
      await probe.end();
    }
  });

  it("refuses to vouch for anything when run as a role that skips row-level security", async () => {
    expect(await isolationProblems(t.client)).toEqual([
      "test can skip row-level security, so this probe proves nothing",
    ]);
  });

  it("catches a table whose policy stopped isolating camps", async () => {
    await t.client.unsafe(`drop policy camp_isolation on inquiry_note`);
    await t.client.unsafe(`create policy camp_isolation on inquiry_note using (true)`);
    try {
      const problems = await isolationProblems(runtime, t.campId);
      expect(problems).toContain("inquiry_note: 1 rows visible with no camp set");
      expect(problems.some((p) => p.startsWith("inquiry_note: 1 other camps' rows"))).toBe(true);
    } finally {
      await t.client.unsafe(`select enable_camp_rls('inquiry_note')`);
    }
    expect(await isolationProblems(runtime, t.campId)).toEqual([]);
  });
});
