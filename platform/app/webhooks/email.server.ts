// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { providerNamed } from "../../../app/lib/email/provider";
import { raiseAlerts } from "../lib/alerts.server";
import { alertText } from "../lib/sending-health.server";
import { handleEmailEvent } from "../lib/suppression.server";

// The email provider's bounce and complaint webhooks, on the platform's public host:
// POST /webhooks/email/<provider>[/<event>] (app/lib/email/ has what each provider sends).
// Every provider authenticates with a static header, "Authorization: Bearer
// <EMAIL_WEBHOOK_SECRET>". /webhooks/plunk/<event> is the address Plunk's workflows had before
// (open-source plan 3.1), kept until they're moved.
//
// Any provider's address works, not just the instance's: bounces for mail sent through the
// old provider still arrive for a while after a switch. An event only counts if it names a
// message this instance sent to that address (handleEmailEvent).

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function emailWebhook(
  request: Request,
  env: PlatformEnv,
  ctx: ExecutionContext,
  providerInPath: string,
  kindInPath: string | undefined,
): Promise<Response> {
  const provider = providerNamed(providerInPath);
  const pathOk =
    provider &&
    (provider.pathKinds
      ? kindInPath !== undefined && provider.pathKinds.includes(kindInPath)
      : kindInPath === undefined);
  if (!provider || !pathOk) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = env.EMAIL_WEBHOOK_SECRET || env.PLUNK_WEBHOOK_SECRET;
  const auth = request.headers.get("Authorization") ?? "";
  if (!secret || secret.length < 32 || !equal(auth, `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad payload", { status: 400 });
  }
  const event = provider.parseWebhook(body, kindInPath);
  if (event === "ignored") return new Response("ok");
  if (!event) return new Response("Bad payload", { status: 400 });

  const sql = postgres(env.HYPERDRIVE_PLATFORM.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: true,
  });
  try {
    const handled = await handleEmailEvent(sql, event);
    if (handled.result === "paused") {
      // Recorded like the hourly health check's alerts, so it doesn't send this one again.
      await raiseAlerts(sql, env, [
        {
          key: `paused:${handled.slug}`,
          subject: `Email paused for ${handled.slug}`,
          text: alertText(handled.slug, env.PLATFORM_DOMAIN, handled.health),
        },
      ]).catch((e) => console.error(`pause alert for ${handled.slug} failed: ${e}`));
    }
    return new Response("ok");
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
