// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EmailProvider } from "./provider";

// Postmark (postmarkapp.com).
//
// Sending: one email per request on the server's default transactional stream, with open and
// link tracking off (Postmark would otherwise rewrite the magic links).
//
// Webhooks: one webhook on the server (/webhooks/email/postmark) with the Bounce and Spam
// Complaint triggers on. The payload names its own event (RecordType), so the address doesn't.

const SEND = "https://api.postmarkapp.com/email";

type Payload = {
  RecordType?: string;
  ID?: number | string;
  Type?: string;
  MessageID?: string;
  Email?: string;
  Inactive?: boolean;
};

// Bounce types that mean the address won't ever take mail. Postmark also deactivates an
// address itself (Inactive) when it decides a bounce is permanent; either is enough.
const HARD = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated"]);

// "Name" <address>, where the name can't break out of its quotes; just the address with no name.
function fromHeader({ name, email }: { name: string; email: string }) {
  const safe = (name ?? "").replace(/["\\<>\r\n]/g, "").trim();
  return safe ? `"${safe}" <${email}>` : email;
}

export const postmark: EmailProvider = {
  async send(apiKey, email) {
    const res = await fetch(SEND, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": apiKey,
      },
      body: JSON.stringify({
        From: fromHeader(email.from),
        To: email.to,
        ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
        Subject: email.subject,
        HtmlBody: email.html,
        TextBody: email.text,
        MessageStream: "outbound",
        TrackOpens: false,
        TrackLinks: "None",
      }),
    });
    const json = (await res.json().catch(() => null)) as {
      ErrorCode?: number;
      MessageID?: string;
    } | null;
    if (!res.ok || json?.ErrorCode) {
      return {
        error: `postmark ${res.status}${json?.ErrorCode ? ` (${json.ErrorCode})` : ""}`,
        providerId: null,
      };
    }
    // Postmark's id for the email; its webhook events carry it as MessageID.
    return { error: null, providerId: json?.MessageID ?? null };
  },

  pathKinds: null,

  parseWebhook(body) {
    const p = (body ?? {}) as Payload;
    const kind =
      p.RecordType === "Bounce" ? "bounce" : p.RecordType === "SpamComplaint" ? "complaint" : null;
    // Deliveries, opens and the rest: nothing to do, and an error would only make Postmark retry.
    if (typeof p.RecordType === "string" && !kind) return "ignored";
    if (!kind || p.ID === undefined || !p.MessageID || !p.Email) return null;
    return {
      id: `postmark:${p.RecordType}:${p.ID}`,
      kind,
      messageId: p.MessageID,
      recipient: p.Email,
      permanent: kind === "complaint" || p.Inactive === true || HARD.has(p.Type ?? ""),
    };
  },
};
