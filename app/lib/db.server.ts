// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as authSchema from "~/db/auth-schema";
import * as appSchema from "~/db/schema";
import { campScopedClient } from "./tenancy.server";

const schema = { ...appSchema, ...authSchema };

// Per request: a pool for transactions and a single pinned connection for standalone
// statements (see tenancy.server.ts). Connections open on first use. In production the
// connection string comes from the Hyperdrive binding (query caching disabled); Hyperdrive
// pools the real connections to Neon.
export type Clients = { pool: postgres.Sql; pinned: postgres.Sql };

export function createClient(connectionString: string, max = 5) {
  return postgres(connectionString, { max, fetch_types: false, prepare: true });
}

export function createClients(connectionString: string): Clients {
  return { pool: createClient(connectionString), pinned: createClient(connectionString, 1) };
}

export const endClients = (c: Clients) =>
  Promise.all([c.pool.end({ timeout: 5 }), c.pinned.end({ timeout: 5 })]);

// A drizzle database acting for one camp (see tenancy.server.ts). Request code always gets
// one of these through getDb(context).
export function campDb(clients: Clients, campId: string, opts: { readOnly: boolean }) {
  const db = drizzle({
    client: campScopedClient(clients.pool, clients.pinned, campId, opts),
    schema,
  });
  // drizzle turns off postgres.js's date parsing by editing the client's parser tables; the
  // pinned client must parse and serialize exactly like the pool.
  Object.assign(clients.pinned.options.parsers, clients.pool.options.parsers);
  Object.assign(clients.pinned.options.serializers, clients.pool.options.serializers);
  return db;
}

// For scripts. With a camp id, every statement acts for that camp, as in the Workers; without
// one, no camp is set. The owner role skips row-level security either way, so scripts that
// run as the owner must also filter by camp themselves.
export function createDb(connectionString: string, campId?: string) {
  const clients = createClients(connectionString);
  const db = campId
    ? campDb(clients, campId, { readOnly: false })
    : drizzle({ client: clients.pool, schema });
  return { db, close: () => endClients(clients) };
}

export type Db = ReturnType<typeof campDb>;
