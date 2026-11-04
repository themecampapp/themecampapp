// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { normalizeHost, type SingleCampEnv, singleCamp } from "./hosts";

// Which camp a request is for, and a database client that can only ever act for that camp.
//
// Every camp table's row-level security policy reads app.camp_id, which is set per
// transaction (never per session: Hyperdrive reuses connections across requests and camps).
// campScopedClient wraps the postgres client so drizzle can't reach the database without it:
// drizzle runs every statement through `unsafe` and every transaction through `begin`, so
// each standalone statement becomes its own short transaction that sets the camp first, and
// each db.transaction sets it on entry (its savepoints inherit it). Demo camps, and suspended
// camps outside the few writes they still allow, get READ ONLY transactions, so the database
// itself refuses their writes.

export type CampRef = {
  id: string;
  slug: string;
  kind: "camp" | "demo";
  status: "active" | "suspended" | "pending_deletion";
};

// A camp slug: lowercase letters, digits and inner hyphens (matches camp_slug_ck).
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The slug for `<slug>.<suffix>`, or null for anything else (the apex, deeper names such as
// x.a.<suffix>, other domains). Case, a port and a trailing dot don't matter.
export function campSlugFromHost(rawHost: string, suffix: string): string | null {
  const host = normalizeHost(rawHost);
  const tail = `.${normalizeHost(suffix)}`;
  if (!host.endsWith(tail)) return null;
  const slug = host.slice(0, -tail.length);
  return SLUG_RE.test(slug) ? slug : null;
}

// The camp a request's host is for: on a single-camp instance its host and nothing else (open-
// source plan 3.4); otherwise <slug>.<APP_HOST_SUFFIX>.
export function campSlugForHost(
  rawHost: string,
  env: SingleCampEnv & { APP_HOST_SUFFIX: string },
): string | null {
  const single = singleCamp(env);
  if (single) return normalizeHost(rawHost) === single.host ? single.slug : null;
  return campSlugFromHost(rawHost, env.APP_HOST_SUFFIX);
}

// The camp table has no row-level security (it's how requests find their camp), so this runs
// on the unscoped client. A camp being deleted is treated as not existing.
export async function lookupCamp(client: postgres.Sql, slug: string): Promise<CampRef | null> {
  const [row] = await client<CampRef[]>`
    select id, slug, kind, status from camp
    where slug = ${slug} and status <> 'pending_deletion'`;
  return row ?? null;
}

// Whether a camp's transactions may write. Demo camps never write. Suspended camps are read
// only, except for the writes signing in needs (asked for with `write`).
export function campReadOnly(camp: CampRef, write: boolean): boolean {
  if (camp.kind === "demo") return true;
  return camp.status !== "active" && !write;
}

type Begin = (fn: (tx: postgres.TransactionSql) => unknown) => Promise<unknown>;
type Params = postgres.ParameterOrJSON<never>[];

// Statements on a pinned connection, one transaction at a time. Every campScopedClient built on
// the same `pinned` (getDb, getWriteDb, getDbForCamp in one request) shares this queue.
const flights = new WeakMap<postgres.Sql, Promise<unknown>>();

function oneAtATime<T>(pinned: postgres.Sql, work: () => Promise<T>): Promise<T> {
  const previous = flights.get(pinned) ?? Promise.resolve();
  const next = previous.then(work, work);
  flights.set(
    pinned,
    next.catch(() => {}),
  );
  return next;
}

// A client that behaves like `pool` for drizzle but acts for one camp only.
//
// Standalone statements go to `pinned`, a client with a single connection (max: 1). Each is
// its own transaction of three messages issued together in one tick, so nothing else can land
// between them: BEGIN plus set_config as one simple-protocol message (the camp id is a checked
// UUID, so inlining it is safe), then the statement, then COMMIT. Only one such transaction is
// in flight at a time: Hyperdrive pools in transaction mode, and a statement queued behind
// another transaction's COMMIT on the same connection can be lost, leaving that connection
// idle in transaction and the request hanging (it hung staging's sign-in confirm page, where
// two loaders query at once). Plain Postgres doesn't do this, so only staging showed it. Explicit transactions
// (db.transaction) use `pool` instead, so a standalone statement issued while a transaction is
// open never waits behind it. Every message is a round trip to Postgres, which is why the camp
// Worker is placed next to the database (config placementRegion).
export function campScopedClient(
  pool: postgres.Sql,
  pinned: postgres.Sql,
  campId: string,
  { readOnly }: { readOnly: boolean },
): postgres.Sql {
  if (!UUID_RE.test(campId)) throw new Error("campScopedClient needs a camp id");
  const beginAndSetCamp = `${readOnly ? "begin read only" : "begin"}; select set_config('app.camp_id', '${campId}', true)`;

  // db.transaction: set_config isn't awaited, so it travels with the first statement.
  const begin: Begin = (fn) =>
    pool.begin(readOnly ? "read only" : "read write", async (tx) => {
      // postgres.js sends a query when it's first awaited or executed, so send this now, before
      // fn runs: nothing in the transaction may reach the server ahead of the camp.
      const setCamp = tx`select set_config('app.camp_id', ${campId}, true)`.execute();
      const [, result] = await Promise.all([setCamp, fn(tx)]);
      return result;
    });

  // A standalone statement (drizzle awaits client.unsafe(...) or calls .values() on it). If
  // it fails, COMMIT rolls its transaction back and the statement's own error is thrown.
  const run = (query: string, params: Params | undefined, values: boolean) =>
    oneAtATime(pinned, async () => {
      // Sent in this order, in one tick: nothing else can land between them.
      const begin = pinned.unsafe(beginAndSetCamp).simple().execute();
      const statement = (
        values ? pinned.unsafe(query, params).values() : pinned.unsafe(query, params)
      ).execute();
      const commit = pinned.unsafe("commit").execute();
      const results = await Promise.allSettled([begin, statement, commit]);
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
      return (results[1] as PromiseFulfilledResult<unknown>).value;
    });
  const unsafe = (query: string, params?: unknown[]) => ({
    values: () => run(query, params as Params, true),
    // biome-ignore lint/suspicious/noThenProperty: drizzle awaits the pending query directly
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      run(query, params as Params, false).then(resolve, reject),
  });

  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "unsafe") return unsafe;
      if (prop === "begin") {
        // drizzle calls begin(fn); postgres.js also allows begin(options, fn).
        return (a: unknown, b?: unknown) => begin((typeof a === "function" ? a : b) as never);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
