// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, type RouterContextProvider } from "react-router";
import { type Auth, createAuth } from "./auth.server";
import { type CampSettings, getCampSettings } from "./data/camp-settings.server";
import { type Clients, campDb, type Db } from "./db.server";
import { type CampRef, campReadOnly } from "./tenancy.server";

// Per-request values shared with loaders, actions and middleware.
export type CloudflareContext = {
  // The request's env, with APP_URL set to this camp's own origin.
  env: Env;
  ctx: ExecutionContext;
  // The camp this request is for (from its host) and the request's database clients.
  camp: CampRef;
  clients: Clients;
  // Work that continues after the response (e.g. sending an email). Awaited before cleanup.
  deferred: Array<Promise<unknown>>;
  // Cleanup that runs once deferred work has settled (e.g. closing the db client).
  cleanup: Array<() => Promise<unknown>>;
  // Set-Cookie values the Worker adds to whatever response goes out, errors included (React
  // Router drops headers on errors thrown in middleware).
  setCookies?: string[];
  // The signed-in member this request was for (set by the _app layout), so the Worker can
  // count them as active today (R74). Not set for support or demo visits.
  personId?: string;
};

export const cloudflareContext = createContext<CloudflareContext>();

const dbContext = createContext<Db | null>(null);
const writeDbContext = createContext<Db | null>(null);

export function defer(context: Readonly<RouterContextProvider>, work: Promise<unknown>) {
  context.get(cloudflareContext).deferred.push(work);
}

// The request's database, acting for the request's camp only. Demo and suspended camps get
// read-only transactions. Work passed to defer() uses the same handle, so it keeps the camp.
export function getDb(context: Readonly<RouterContextProvider>): Db {
  const existing = context.get(dbContext);
  if (existing) return existing;
  const { clients, camp } = context.get(cloudflareContext);
  const db = campDb(clients, camp.id, { readOnly: campReadOnly(camp, false) });
  (context as RouterContextProvider).set(dbContext, db);
  return db;
}

// For the few writes a suspended camp still allows: signing in (sessions, the sign-in log,
// linking a first sign-in). Demo camps stay read-only.
export function getWriteDb(context: Readonly<RouterContextProvider>): Db {
  const existing = context.get(writeDbContext);
  if (existing) return existing;
  const { clients, camp } = context.get(cloudflareContext);
  const db = campDb(clients, camp.id, { readOnly: campReadOnly(camp, true) });
  (context as RouterContextProvider).set(writeDbContext, db);
  return db;
}

// A database acting for another camp, for the rare change that belongs to one person across
// their camps (their sign-in email). Never for reading another camp's data.
// It follows that camp's own rules: a demo camp stays read-only, and a suspended camp allows
// only personal writes like this one (as it does for signing in).
export function getDbForCamp(context: Readonly<RouterContextProvider>, camp: CampRef): Db {
  const { clients } = context.get(cloudflareContext);
  return campDb(clients, camp.id, { readOnly: campReadOnly(camp, true) });
}

const settingsContext = createContext<Promise<CampSettings> | null>(null);

// The camp's settings (name, accent, features, ...), read once per request.
export function getSettings(context: Readonly<RouterContextProvider>): Promise<CampSettings> {
  const existing = context.get(settingsContext);
  if (existing) return existing;
  const settings = getCampSettings(getDb(context));
  (context as RouterContextProvider).set(settingsContext, settings);
  return settings;
}

const authContext = createContext<Auth | null>(null);

// The Better Auth instance for this request, bound to the request's db handle.
export function getAuth(context: Readonly<RouterContextProvider>): Auth {
  const existing = context.get(authContext);
  if (existing) return existing;
  const { env, camp } = context.get(cloudflareContext);
  const auth = createAuth(getWriteDb(context), env, (work) => defer(context, work), camp.id);
  (context as RouterContextProvider).set(authContext, auth);
  return auth;
}

// Called by the Worker entry once the response is ready.
export async function finishRequest(cf: CloudflareContext) {
  await Promise.allSettled(cf.deferred);
  await Promise.allSettled(cf.cleanup.map((fn) => fn()));
}
