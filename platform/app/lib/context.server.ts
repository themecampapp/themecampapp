// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { createContext } from "react-router";

// What every console request has, set by platform/workers/app.ts after it has verified the
// Access token and found the operator.
export type Operator = { id: string; email: string; name: string };
export type OpsContext = {
  env: PlatformEnv;
  sql: postgres.Sql;
  operator: Operator;
  waitUntil: (p: Promise<unknown>) => void;
};

export const opsContext = createContext<OpsContext>();

// What the public site's pages (the apex host) need: no database, only settings.
// product: the instance's name (PRODUCT_NAME, open-source plan 3.5). supportUrl: its support
// community (SUPPORT_URL), or null for none. sourceUrl: its source code (SOURCE_URL, AGPL section
// 13), or null when unknown.
export type PublicContext = {
  // The instance's settings (legal pages, pilot agreement; open-source plan 3.6). No secrets are
  // read from it on public pages.
  env: PlatformEnv;
  domain: string;
  product: string;
  contact: string;
  supportUrl: string | null;
  sourceUrl: string | null;
};
export const publicContext = createContext<PublicContext>();

// The sign-up page (issue #73) is the one public page with a database connection.
export type SignupContext = { env: PlatformEnv; sql: postgres.Sql; ip: string | null };
export const signupContext = createContext<SignupContext>();
