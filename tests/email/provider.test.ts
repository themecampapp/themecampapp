// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { plunk } from "~/lib/email/plunk";
import { postmark } from "~/lib/email/postmark";
import { type OutgoingEmail, sendEmail } from "~/lib/email/provider";

// Open-source plan 3.1: each adapter's requests and replies, as its provider documents them.
// The rest of the suite runs against one provider at a time (tests/helpers/mail.ts).

afterEach(() => vi.unstubAllGlobals());

const email: OutgoingEmail = {
  to: "nova@example.com",
  from: { name: 'Test "Camp" via <Theme Camp App>', email: "notify@mail.themecamp.test" },
  replyTo: "hello@testcamp.example",
  subject: "You're invited",
  html: "<p>Hi</p>",
  text: "Hi",
};

function stub(reply: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    typeof reply === "function" ? reply() : reply.clone(),
  );
  vi.stubGlobal("fetch", fetchMock);
  const call = (i = 0) => ({
    url: fetchMock.mock.calls[i][0],
    headers: new Headers(fetchMock.mock.calls[i][1]?.headers),
    body: JSON.parse(String(fetchMock.mock.calls[i][1]?.body)),
  });
  return { fetchMock, call };
}

describe("Plunk", () => {
  it("sends one email with no contact data, never subscribed, and returns Plunk's id", async () => {
    const { call } = stub(
      Response.json({ success: true, data: { emails: [{ contact: { id: "c" }, email: "em_1" }] } }),
    );
    expect(await plunk.send("sk_live", email)).toEqual({ error: null, providerId: "em_1" });
    const { url, headers, body } = call();
    expect(url).toBe("https://next-api.useplunk.com/v1/send");
    expect(headers.get("authorization")).toBe("Bearer sk_live");
    expect(body).toEqual({
      to: "nova@example.com",
      from: email.from,
      reply: "hello@testcamp.example",
      subject: "You're invited",
      body: "<p>Hi</p>",
      subscribed: false,
    });
  });

  it("reports a refused send", async () => {
    stub(new Response("nope", { status: 401 }));
    expect(await plunk.send("sk", email)).toEqual({ error: "plunk 401", providerId: null });
  });

  it("takes the event from the address, and only a transient bounce is soft", () => {
    const body = (bounceType?: string) => ({
      contact: { email: "p1@example.com" },
      execution: { id: "exec_1" },
      event: { emailId: "em_1", bounceType },
    });
    expect(plunk.parseWebhook(body("Permanent"), "bounce")).toEqual({
      id: "exec_1",
      kind: "bounce",
      messageId: "em_1",
      recipient: "p1@example.com",
      permanent: true,
    });
    expect(plunk.parseWebhook(body("Transient"), "bounce")).toMatchObject({ permanent: false });
    expect(plunk.parseWebhook(body(), "complaint")).toMatchObject({ kind: "complaint" });
    expect(plunk.parseWebhook(body(), "delivery")).toBeNull();
    expect(plunk.parseWebhook(body(), undefined)).toBeNull();
    expect(plunk.parseWebhook({ contact: { email: "p1@example.com" } }, "bounce")).toBeNull();
  });
});

describe("Postmark", () => {
  it("sends one email without tracking, on the transactional stream, and returns its id", async () => {
    const { call } = stub(
      Response.json({ To: "nova@example.com", MessageID: "pm-1", ErrorCode: 0, Message: "OK" }),
    );
    expect(await postmark.send("server-token", email)).toEqual({
      error: null,
      providerId: "pm-1",
    });
    const { url, headers, body } = call();
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(headers.get("x-postmark-server-token")).toBe("server-token");
    expect(headers.get("authorization")).toBeNull();
    expect(body).toEqual({
      // The display name can't break out of its quotes.
      From: '"Test Camp via Theme Camp App" <notify@mail.themecamp.test>',
      To: "nova@example.com",
      ReplyTo: "hello@testcamp.example",
      Subject: "You're invited",
      HtmlBody: "<p>Hi</p>",
      TextBody: "Hi",
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
    });
  });

  it("leaves out the reply-to when there is none, and a sender's name when it's empty", async () => {
    const { call } = stub(Response.json({ MessageID: "pm-1", ErrorCode: 0 }));
    await postmark.send("t", { ...email, replyTo: undefined });
    expect(call().body).not.toHaveProperty("ReplyTo");
    await postmark.send("t", { ...email, from: { name: '"<>"', email: "a@b.test" } });
    expect(call(1).body.From).toBe("a@b.test");
  });

  it("reports a refused send with Postmark's error code", async () => {
    stub(Response.json({ ErrorCode: 406, Message: "Inactive recipient" }, { status: 422 }));
    expect(await postmark.send("t", email)).toEqual({
      error: "postmark 422 (406)",
      providerId: null,
    });
    stub(new Response("bad gateway", { status: 502 }));
    expect(await postmark.send("t", email)).toEqual({ error: "postmark 502", providerId: null });
  });

  it("takes the event from the payload; hard bounces and deactivated addresses are permanent", () => {
    const bounce = (Type: string, Inactive: boolean) => ({
      RecordType: "Bounce",
      ID: 42,
      Type,
      MessageID: "pm-1",
      Email: "p1@example.com",
      Inactive,
    });
    expect(postmark.parseWebhook(bounce("HardBounce", true), undefined)).toEqual({
      id: "postmark:Bounce:42",
      kind: "bounce",
      messageId: "pm-1",
      recipient: "p1@example.com",
      permanent: true,
    });
    expect(postmark.parseWebhook(bounce("SoftBounce", false), undefined)).toMatchObject({
      permanent: false,
    });
    expect(postmark.parseWebhook(bounce("SpamNotification", true), undefined)).toMatchObject({
      permanent: true,
    });
    expect(
      postmark.parseWebhook(
        { RecordType: "SpamComplaint", ID: 42, MessageID: "pm-1", Email: "p1@example.com" },
        undefined,
      ),
    ).toMatchObject({ id: "postmark:SpamComplaint:42", kind: "complaint", permanent: true });
    expect(postmark.parseWebhook({ RecordType: "Open", ID: 1 }, undefined)).toBe("ignored");
    expect(postmark.parseWebhook({ RecordType: "Bounce", ID: 1 }, undefined)).toBeNull();
    expect(postmark.parseWebhook({}, undefined)).toBeNull();
  });
});

describe("sending through the instance's provider", () => {
  const ok = () =>
    Response.json({ data: { emails: [{ email: "em_1" }] }, MessageID: "pm-1", ErrorCode: 0 });

  it("uses the configured provider, and Plunk when none is set", async () => {
    const { call } = stub(async () => ok());
    await sendEmail({ EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "k" }, email);
    await sendEmail({ EMAIL_API_KEY: "k" }, email);
    expect(call(0).url).toBe("https://api.postmarkapp.com/email");
    expect(call(1).url).toBe("https://next-api.useplunk.com/v1/send");
  });

  it("reads the key from EMAIL_API_KEY, then its old name", async () => {
    const { call } = stub(async () => ok());
    await sendEmail({ EMAIL_API_KEY: "new", PLUNK_SECRET_KEY: "old" }, email);
    await sendEmail({ PLUNK_SECRET_KEY: "old" }, email);
    expect(call(0).headers.get("authorization")).toBe("Bearer new");
    expect(call(1).headers.get("authorization")).toBe("Bearer old");
  });

  it("sends nothing without a key or with a provider it doesn't know", async () => {
    const { fetchMock } = stub(ok());
    expect(await sendEmail({ EMAIL_PROVIDER: "postmark" }, email)).toEqual({
      error: "no EMAIL_API_KEY",
      providerId: null,
    });
    expect(await sendEmail({ EMAIL_PROVIDER: "sendgrid", EMAIL_API_KEY: "k" }, email)).toEqual({
      error: 'unknown EMAIL_PROVIDER "sendgrid"',
      providerId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a network error into a failed send", async () => {
    stub(async () => {
      throw new TypeError("network down");
    });
    expect(await sendEmail({ EMAIL_API_KEY: "k" }, email)).toEqual({
      error: "TypeError",
      providerId: null,
    });
  });
});
