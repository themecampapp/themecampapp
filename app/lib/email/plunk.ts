// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EmailEvent, EmailProvider } from "./provider";

// Plunk (useplunk.com), the hosted service's provider.
//
// Sending: one email per request, HTML only (Plunk derives the plain text). Nothing else about
// the person is sent: no contact data, and they're never subscribed to anything.
//
// Webhooks: the Webhook step of a Plunk workflow triggered by email.bounce or email.complaint.
// Plunk's default payload doesn't name the event, so the webhook's address does
// (/webhooks/email/plunk/bounce and .../complaint).

const SEND = "https://next-api.useplunk.com/v1/send";

type Payload = {
  contact?: { email?: string };
  execution?: { id?: string };
  event?: { emailId?: string; bounceType?: string };
};

const KINDS: Record<string, EmailEvent["kind"]> = { bounce: "bounce", complaint: "complaint" };

export const plunk: EmailProvider = {
  async send(apiKey, email) {
    const res = await fetch(SEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: email.to,
        from: email.from,
        ...(email.replyTo ? { reply: email.replyTo } : {}),
        subject: email.subject,
        body: email.html,
        subscribed: false,
      }),
    });
    if (!res.ok) return { error: `plunk ${res.status}`, providerId: null };
    const json = (await res.json().catch(() => null)) as {
      data?: { emails?: Array<{ email?: string }> };
    } | null;
    // Plunk's id for the email; its webhook events carry it as emailId.
    return { error: null, providerId: json?.data?.emails?.[0]?.email ?? null };
  },

  pathKinds: Object.keys(KINDS),

  parseWebhook(body, kindInPath) {
    const kind = kindInPath ? KINDS[kindInPath] : undefined;
    if (!kind) return null;
    const p = (body ?? {}) as Payload;
    const id = p.execution?.id;
    const messageId = p.event?.emailId;
    const recipient = p.contact?.email;
    if (!id || !messageId || !recipient) return null;
    return { id, kind, messageId, recipient, permanent: p.event?.bounceType !== "Transient" };
  },
};
