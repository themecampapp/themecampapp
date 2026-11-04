// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { plunk } from "./plunk";
import { postmark } from "./postmark";

// The email provider behind both Workers (open-source plan 3.1): the instance picks one in
// config (mail.provider, the EMAIL_PROVIDER var). Everything about whether an email may go
// (the allowlist, suppression, daily caps, pauses, send_log) is decided before it reaches
// here, and the same for every provider; an adapter only hands one email over, and turns the
// provider's bounce and complaint webhooks into an EmailEvent.

export type OutgoingEmail = {
  to: string;
  from: { name: string; email: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string; // the same email as plain text, for providers that send both parts
};

// The provider's id for the email (its webhooks name the email by it), or why it wasn't sent.
export type SendResult = { error: string | null; providerId: string | null };

// One bounce or complaint reported by the provider (R36), parsed from its webhook.
export type EmailEvent = {
  id: string; // unique per delivery of this event, so a repeat is a no-op
  kind: "bounce" | "complaint";
  messageId: string; // the provider's id for the email, as stored in send_log.provider_id
  recipient: string;
  permanent: boolean; // bounces: hard (true) or soft
};

export type EmailProvider = {
  send(apiKey: string, email: OutgoingEmail): Promise<SendResult>;
  // The events a webhook address names (/webhooks/email/<provider>/<event>), or null when the
  // payload names its own and the address is just /webhooks/email/<provider>.
  pathKinds: readonly string[] | null;
  // The webhook's JSON body as an event: "ignored" for an event this app doesn't act on, null
  // for a payload that isn't one. kindInPath is the event the address names, if any.
  parseWebhook(body: unknown, kindInPath: string | undefined): EmailEvent | "ignored" | null;
};

const PROVIDERS: Record<string, EmailProvider> = { plunk, postmark };

export type EmailEnv = {
  // "plunk" or "postmark", from config. Unset means Plunk (the hosted service's, before the var).
  EMAIL_PROVIDER?: string;
  // The provider's API key (a Worker secret). PLUNK_SECRET_KEY is its old name, still read
  // until every instance has moved to EMAIL_API_KEY (docs/operating.md).
  EMAIL_API_KEY?: string;
  PLUNK_SECRET_KEY?: string;
};

export const emailApiKey = (env: EmailEnv) => env.EMAIL_API_KEY || env.PLUNK_SECRET_KEY || null;

// The provider by name ("plunk", "postmark"), or null for any other name.
export const providerNamed = (name: string): EmailProvider | null =>
  Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;

export const emailProvider = (env: EmailEnv) => providerNamed(env.EMAIL_PROVIDER || "plunk");

// Hands one email to the instance's provider. Never throws: a network error or a missing
// setting comes back as the error.
export async function sendEmail(env: EmailEnv, email: OutgoingEmail): Promise<SendResult> {
  const provider = emailProvider(env);
  if (!provider)
    return { error: `unknown EMAIL_PROVIDER "${env.EMAIL_PROVIDER}"`, providerId: null };
  const key = emailApiKey(env);
  if (!key) return { error: "no EMAIL_API_KEY", providerId: null };
  try {
    return await provider.send(key, email);
  } catch (e) {
    return { error: e instanceof Error ? e.name : "send failed", providerId: null };
  }
}
