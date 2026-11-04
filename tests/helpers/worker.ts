// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { invite, person } from "~/db/schema";
import { APP_HOST_SUFFIX, APP_URL, INSTANCE } from "./context";
import type { TestDb } from "./db";
import { htmlToText, isSend, readSend, type SentEmail, sendResponse, TEST_EMAIL_ENV } from "./mail";

// Runs the built production bundle inside workerd (the real Workers runtime) via Miniflare,
// with Hyperdrive pointed at the test database. Outbound fetches (the email provider) are
// intercepted.
export type TestWorker = {
  fetch: (request: Request) => Promise<Response>;
  emails: Array<{ to: string; subject: string; text: string }>;
  // Messages posted to the operator's Discord webhook (issues #32, #79).
  discord: string[];
  // Runs the Worker's cron handler once, as Cloudflare would, and waits for its work.
  scheduled: () => Promise<void>;
  // What Cloudflare's Turnstile siteverify answers; tests can change it.
  turnstile: { success: boolean; hostname: string; action: string };
  dispose: () => Promise<void>;
  // Raw bytes of an object in the PHOTOS bucket (null if absent), and the key list.
  photo: (key: string) => Promise<Uint8Array | null>;
  photoKeys: () => Promise<string[]>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
};

const ROOT = fileURLToPath(new URL("../../build/server", import.meta.url));
export const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1000/test-token";

// Every JS chunk of the bundle, entry first, as workerd needs them listed up front.
function bundleModules() {
  const files = (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(ROOT, f));
  files.sort((a, b) => Number(b.endsWith("/index.js")) - Number(a.endsWith("/index.js")));
  return files.map((path) => ({ type: "ESModule" as const, path, contents: undefined }));
}

// `bindings` overrides the test instance's settings (e.g. no SUPPORT_URL).
export async function startWorker(
  t: TestDb,
  bindings: Record<string, string> = {},
): Promise<TestWorker> {
  const emails: TestWorker["emails"] = [];
  const discord: string[] = [];
  const turnstile: TestWorker["turnstile"] = {
    success: true,
    hostname: new URL(APP_URL).hostname,
    action: "join",
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: bundleModules(),
      modulesRoot: ROOT,
      compatibilityDate: "2026-09-23",
      compatibilityFlags: ["nodejs_compat"],
      // The camp Worker connects as app_runtime, as in production.
      hyperdrives: { HYPERDRIVE: t.runtimeUrl },
      bindings: {
        APP_URL,
        APP_HOST_SUFFIX,
        MAIL_FROM: "Theme Camp App <camp@test>",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
        ...TEST_EMAIL_ENV,
        TURNSTILE_SECRET: "turnstile-test-secret",
        TURNSTILE_SITE_KEY: "site-key-test",
        DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK,
        ...INSTANCE,
        ...bindings,
      },
      r2Buckets: ["PHOTOS"],
      images: { binding: "IMAGES" },
      ratelimits: { JOIN_LIMITER: { namespace_id: "1001", simple: { limit: 5, period: 60 } } },
      outboundService: async (req) => {
        if (isSend(req.url)) {
          const m = readSend(req.url, await req.text()) as SentEmail;
          emails.push({ to: m.to, subject: m.subject, text: htmlToText(m.body) });
          return sendResponse("email_1");
        }
        if (req.url === DISCORD_WEBHOOK) {
          // Only messages that can't ping anyone are accepted (and recorded).
          const m = (await req.json()) as { content: string; allowed_mentions?: { parse?: [] } };
          if (m.allowed_mentions?.parse?.length !== 0)
            return new Response("mentions", { status: 400 });
          discord.push(m.content);
          return new Response(null, { status: 204 });
        }
        if (new URL(req.url).hostname === "challenges.cloudflare.com") {
          return Response.json(turnstile);
        }
        return new Response("blocked in tests", { status: 599 });
      },
    }),
  );
  await mf.ready;
  return {
    emails,
    discord,
    turnstile,
    fetch: async (request) => {
      const res = await mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.method === "GET" ? undefined : new Uint8Array(await request.arrayBuffer()),
        redirect: "manual",
      });
      return res as unknown as Response;
    },
    dispose: () => mf.dispose(),
    scheduled: async () => {
      const worker = (await mf.getWorker()) as unknown as {
        scheduled: (o: { cron: string }) => Promise<unknown>;
      };
      await worker.scheduled({ cron: "0 16 * * *" });
    },
    photo: async (key) => {
      const bucket = (await mf.getR2Bucket("PHOTOS")) as unknown as R2Bucket;
      const obj = await bucket.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    putObject: async (key, bytes, contentType) => {
      const bucket = (await mf.getR2Bucket("PHOTOS")) as unknown as R2Bucket;
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    photoKeys: async () => {
      const bucket = (await mf.getR2Bucket("PHOTOS")) as unknown as R2Bucket;
      return (await bucket.list()).objects.map((o) => o.key);
    },
  };
}

// `base` picks the camp (its origin); the default test camp unless given.
export function get(path: string, cookie?: string, base = APP_URL) {
  return new Request(`${base}${path}`, { headers: cookie ? { cookie } : {} });
}

export function post(
  path: string,
  fields: Record<string, string> | Array<[string, string]>,
  opts: { cookie?: string; origin?: string; base?: string } = {},
) {
  const base = opts.base ?? APP_URL;
  const headers: Record<string, string> = {
    origin: opts.origin ?? base,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${base}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

export async function invitePerson(
  t: TestDb,
  email: string,
  values: Partial<typeof person.$inferInsert> = {},
) {
  const [p] = await t.db
    .insert(person)
    .values({ legalName: "Test Camper", email, ...values })
    .returning();
  // The invite belongs to the person's camp (pass values.campId for a camp other than the
  // default test camp).
  await t.db.insert(invite).values({ campId: p.campId, personId: p.id, email, status: "pending" });
  return p;
}

async function waitForEmail(w: TestWorker, to: string, after: number) {
  for (let i = 0; i < 100; i++) {
    const found = w.emails.slice(after).find((e) => e.to === to);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no sign-in email sent to ${to}`);
}

// Full magic-link sign-in through the Worker; returns the session cookie header.
// The magic-link token emailed to `email` after asking for one at `base`.
export async function requestLinkToken(w: TestWorker, email: string, base = APP_URL) {
  const before = w.emails.length;
  await w.fetch(post("/sign-in", { email }, { base }));
  const mail = await waitForEmail(w, email, before);
  const line = mail.text.split("\n").find((l) => l.includes("/sign-in/confirm")) ?? "";
  return new URL(line).searchParams.get("token") ?? "";
}

export async function signIn(w: TestWorker, email: string, base = APP_URL): Promise<string> {
  const token = await requestLinkToken(w, email, base);
  const res = await w.fetch(post("/sign-in/confirm", { token }, { base }));
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

// A multipart upload, as the profile photo form sends it.
export function upload(
  path: string,
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Uint8Array },
  cookie: string,
  field = "photo",
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set(
    field,
    new File([file.bytes as Uint8Array<ArrayBuffer>], file.name, { type: file.type }),
  );
  return new Request(`${APP_URL}${path}`, {
    method: "POST",
    headers: { origin: APP_URL, cookie },
    body: form,
  });
}
