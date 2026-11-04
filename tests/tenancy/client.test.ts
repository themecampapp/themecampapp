// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campScopedClient } from "~/lib/tenancy.server";
import { createTestDb, type TestDb } from "../helpers/db";

// The camp-bound client on its own, against a real Postgres, as app_runtime.
let t: TestDb;
let pool: postgres.Sql;
let pinned: postgres.Sql;
let scoped: postgres.Sql;

beforeAll(async () => {
  t = await createTestDb();
  pool = postgres(t.runtimeUrl, { max: 5, fetch_types: false, onnotice: () => {} });
  pinned = postgres(t.runtimeUrl, { max: 1, fetch_types: false, onnotice: () => {} });
  scoped = campScopedClient(pool, pinned, t.campId, { readOnly: false });
});
afterAll(async () => {
  await Promise.all([pool.end(), pinned.end()]);
  await t.drop();
});

const setting = "select current_setting('app.camp_id', true) as c";
type Row = { c: string };

describe("campScopedClient", () => {
  it("acts for its camp on a standalone statement", async () => {
    const [r] = (await scoped.unsafe(setting)) as unknown as Row[];
    expect(r.c).toBe(t.campId);
  });

  it("returns rows as arrays through .values(), as drizzle asks for them", async () => {
    const rows = await (
      scoped.unsafe("select 1 as a, 2 as b") as unknown as { values(): Promise<unknown[][]> }
    ).values();
    expect(rows).toEqual([[1, 2]]);
  });

  it("sets the camp before a transaction's first statement, even one issued at once", async () => {
    const rows = (await scoped.begin((tx) => tx.unsafe(setting))) as unknown as Row[];
    expect(rows[0].c).toBe(t.campId);
  });

  it("keeps the camp inside a savepoint (drizzle's nested transactions)", async () => {
    const rows = (await scoped.begin((tx) =>
      tx.savepoint((sp) => sp.unsafe(setting)),
    )) as unknown as Row[];
    expect(rows[0].c).toBe(t.campId);
  });

  it("runs one statement's transaction at a time on the pinned connection", async () => {
    // Hyperdrive (transaction pooling) loses a statement queued behind another transaction's
    // COMMIT on the same connection, which hung staging's sign-in confirm page (two loaders
    // querying at once). So a flight must finish before the next one starts.
    let open = 0;
    let maxOpen = 0;
    const spy = new Proxy(pinned, {
      get(target, prop, receiver) {
        if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
        return (q: string, params?: never[]) => {
          const query = target.unsafe(q, params);
          if (q.startsWith("begin")) maxOpen = Math.max(maxOpen, ++open);
          if (q === "commit") {
            const execute = query.execute.bind(query);
            query.execute = () => {
              const sent = execute();
              sent.then(
                () => open--,
                () => open--,
              );
              return sent;
            };
          }
          return query;
        };
      },
    });
    const client = campScopedClient(pool, spy, t.campId, { readOnly: false });
    const other = campScopedClient(pool, spy, t.campId, { readOnly: true });
    const rows = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? client : other).unsafe(setting)),
    );
    expect(rows.map((r) => (r as unknown as Row[])[0].c)).toEqual(Array(20).fill(t.campId));
    expect(maxOpen).toBe(1);
  });

  it("keeps every one of many concurrent statements on its camp, failures included", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        scoped.unsafe(i % 13 === 0 ? "select 1/0 as c" : setting),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    const seen = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => ((r as PromiseFulfilledResult<unknown>).value as Row[])[0].c);
    expect(failed).toHaveLength(8);
    expect(new Set(seen)).toEqual(new Set([t.campId]));
    // Nothing is left behind on the pinned connection.
    const [after] = await pinned`select current_setting('app.camp_id', true) as c`;
    expect(after.c).toBe("");
  });

  it("doesn't deadlock when a standalone statement runs while a transaction is open", async () => {
    const inner = await scoped.begin(async (tx) => {
      await tx.unsafe("select pg_sleep(0.05)");
      return scoped.unsafe(setting); // on the pinned connection, not the transaction's
    });
    expect((inner as unknown as Row[])[0].c).toBe(t.campId);
  });

  it("refuses a camp id that isn't a UUID (it's inlined into the BEGIN message)", () => {
    expect(() =>
      campScopedClient(pool, pinned, "x'); drop table person; --", { readOnly: false }),
    ).toThrow(/camp id/);
  });
});
