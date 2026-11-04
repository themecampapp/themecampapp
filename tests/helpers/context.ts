// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { RouterContextProvider } from "react-router";
import { vi } from "vitest";
import { type CloudflareContext, cloudflareContext, finishRequest } from "~/lib/context.server";
import { createClients, endClients } from "~/lib/db.server";
import { fakeSend, htmlToText, TEST_EMAIL_ENV } from "./mail";
import { TEST_CAMP_ID, TEST_CAMP_SLUG } from "./seed";

export const APP_HOST_SUFFIX = "themecamp.test";
// The default test camp's address.
export const APP_URL = `https://${TEST_CAMP_SLUG}.${APP_HOST_SUFFIX}`;
// The test instance's own settings (open-source plan 2.4), as the generated config sets them.
export const INSTANCE = {
  PRODUCT_NAME: "Theme Camp App",
  OPERATOR_NAME: "Test Operator LLC",
  CONTACT_EMAIL: "hello@themecamp.test",
  SUPPORT_URL: "https://discord.gg/support-test",
  SOURCE_URL: "https://code.example.org/themecampapp",
  LEGAL_DIR: "hosted",
  ICON_DIR: "hosted",
  PILOT_AGREEMENT: "true",
  // The hosted-only features (open-source plan 3.7), all on as on the hosted service.
  SIGNUP_PAGE: "true",
  FEEDBACK: "true",
  USAGE_COUNTS: "true",
  DISCORD: "true",
};

// Builds the per-request context the Worker entry would, for the default test camp, with the
// database reached as the app's own role (pass TestDb.runtimeUrl) so row-level security applies.
export function makeContext(databaseUrl: string, env: Partial<Env> = {}) {
  const clients = createClients(databaseUrl);
  const cf: CloudflareContext = {
    env: {
      HYPERDRIVE: { connectionString: databaseUrl } as Hyperdrive,
      APP_URL,
      APP_HOST_SUFFIX,
      MAIL_FROM: "Theme Camp App <camp@test>",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
      ...TEST_EMAIL_ENV,
      ...INSTANCE,
      ...env,
    } as Env,
    ctx: { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    camp: { id: TEST_CAMP_ID, slug: TEST_CAMP_SLUG, kind: "camp", status: "active" },
    clients,
    deferred: [],
    cleanup: [() => endClients(clients)],
  };
  const context = new RouterContextProvider();
  context.set(cloudflareContext, cf);
  return { context, finish: () => finishRequest(cf), cf };
}

// Replaces global fetch with a stand-in for the email provider and records the emails "sent",
// as text.
export function stubMail() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const fetchMock = vi.fn(
    fakeSend((m) => sent.push({ to: m.to, subject: m.subject, text: htmlToText(m.body) })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}

export function formRequest(
  path: string,
  fields: Record<string, string>,
  headers: HeadersInit = {},
) {
  return new Request(`${APP_URL}${path}`, {
    method: "POST",
    headers: { origin: APP_URL, "cf-connecting-ip": "203.0.113.7", ...headers },
    body: new URLSearchParams(fields),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: route args are loosely typed in tests
export const args = (request: Request, context: RouterContextProvider): any => ({
  request,
  context,
  params: {},
});
