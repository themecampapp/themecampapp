// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// What a send request carried, as the plain text the recipient reads: the app sends an
// HTML body (see app/lib/email-html.ts), so tests turn it back into text to check the wording.
export function htmlToText(html: string) {
  return html
    .replace(/^[\s\S]*?<body[^>]*>/, "")
    .replace(/<\/body>[\s\S]*$/, "")
    .replace(/<br>/g, "\n")
    .replace(/<\/p>\n?<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

// The email provider the suite runs against, like an instance's config mail.provider: Plunk,
// or Postmark with TEST_EMAIL_PROVIDER=postmark (npm run test:postmark). Tests stub the
// provider's API at the network, so the same tests cover either adapter (app/lib/email/).
export const EMAIL_PROVIDER: "plunk" | "postmark" =
  process.env.TEST_EMAIL_PROVIDER === "postmark" ? "postmark" : "plunk";

// The Worker env for it (the key is a stand-in).
export const TEST_EMAIL_ENV = { EMAIL_PROVIDER, EMAIL_API_KEY: "sk_test" };

const SEND_URL = {
  plunk: "https://next-api.useplunk.com/v1/send",
  postmark: "https://api.postmarkapp.com/email",
}[EMAIL_PROVIDER];

// An email as the provider was asked to send it, the same for every provider. body is the
// HTML part.
export type SentEmail = {
  to: string;
  from: { name: string; email: string };
  reply?: string;
  subject: string;
  body: string;
};

export const isSend = (url: string) => url === SEND_URL;

// A send request to the suite's provider, as a SentEmail; null for any other request (one to
// another provider included, so mail sent the wrong way fails the test).
export function readSend(url: string, body: string): SentEmail | null {
  if (!isSend(url)) return null;
  const m = JSON.parse(body);
  if (EMAIL_PROVIDER === "plunk") {
    return { to: m.to, from: m.from, reply: m.reply, subject: m.subject, body: m.body };
  }
  const from = /^"(.*)" <(.+)>$/.exec(m.From);
  return {
    to: m.To,
    from: { name: from?.[1] ?? "", email: from?.[2] ?? m.From },
    reply: m.ReplyTo,
    subject: m.Subject,
    body: m.HtmlBody,
  };
}

// The provider's reply to a send that it accepted, giving the email this id.
export const sendResponse = (id: string) =>
  EMAIL_PROVIDER === "plunk"
    ? Response.json({
        success: true,
        data: { emails: [{ contact: { id: "c", email: "x" }, email: id }] },
      })
    : Response.json({
        To: "x",
        SubmittedAt: new Date().toISOString(),
        MessageID: id,
        ErrorCode: 0,
        Message: "OK",
      });

// A stand-in for fetch that takes the provider's sends, passing each to onSend, and refuses
// anything else.
export const fakeSend =
  (onSend: (m: SentEmail) => void, id = "email_1") =>
  async (url: string | URL | Request, init?: RequestInit) => {
    const m = readSend(String(url), String(init?.body));
    if (!m) return new Response("blocked in tests", { status: 599 });
    onSend(m);
    return sendResponse(id);
  };
