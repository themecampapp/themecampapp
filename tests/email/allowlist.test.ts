// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sendLog } from "~/db/schema";
import { mailAllowed, sendMail, sendMailBatch } from "~/lib/mail.server";
import { APP_URL, stubMail } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { readSend, sendResponse, TEST_EMAIL_ENV } from "../helpers/mail";

describe("mailAllowed", () => {
  it("allows everyone when no allowlist is set (production)", () => {
    expect(mailAllowed(undefined, "anyone@example.com")).toBe(true);
    expect(mailAllowed("", "anyone@example.com")).toBe(true);
    expect(mailAllowed(" , ", "anyone@example.com")).toBe(true);
  });

  it("sends to nobody on a restricted instance (staging) whose allowlist is missing", () => {
    expect(mailAllowed(undefined, "anyone@example.com", true)).toBe(false);
    expect(mailAllowed("", "anyone@example.com", true)).toBe(false);
    expect(mailAllowed("ops@example.com", "ops@example.com", true)).toBe(true);
    expect(mailAllowed("ops@example.com", "camper@example.com", true)).toBe(false);
  });

  it("matches exact addresses and @domain entries, ignoring case and spaces", () => {
    const list = " Casey@Example.com , @example.net";
    expect(mailAllowed(list, "casey@example.com")).toBe(true);
    expect(mailAllowed(list, "ops@Example.NET")).toBe(true);
    expect(mailAllowed(list, "camper@example.com")).toBe(false);
    // A domain entry doesn't match a look-alike that merely ends with the same letters.
    expect(mailAllowed(list, "x@evilexample.net")).toBe(false);
  });
});

describe("sending with MAIL_ALLOWLIST (staging)", () => {
  let t: TestDb;
  const env = {
    ...TEST_EMAIL_ENV,
    MAIL_FROM: "Theme Camp App <test@test>",
    APP_URL,
    PRODUCT_NAME: "Theme Camp App",
    MAIL_ALLOWLIST: "ops@example.com",
  };
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.drop());
  afterEach(() => vi.unstubAllGlobals());

  it("sends to an allowlisted address", async () => {
    const mail = stubMail();
    expect(await sendMail(t.db, env, "invite", "ops@example.com", { url: `${APP_URL}/x` })).toBe(
      "sent",
    );
    expect(mail.sent.map((m) => m.to)).toEqual(["ops@example.com"]);
  });

  it("skips and logs anyone else without calling the email provider", async () => {
    const mail = stubMail();
    expect(await sendMail(t.db, env, "invite", "camper@example.com", { url: `${APP_URL}/x` })).toBe(
      "skipped",
    );
    expect(mail.fetchMock).not.toHaveBeenCalled();
    const [row] = await t.db
      .select()
      .from(sendLog)
      .where(eq(sendLog.recipient, "camper@example.com"));
    expect(row.status).toBe("skipped");
  });

  it("batch sends only to allowlisted addresses and reports the rest as not sent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sendResponse("email_1"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendMailBatch(t.db, env, "invite", [
      { to: "ops@example.com", url: `${APP_URL}/a` },
      { to: "someone@example.com", url: `${APP_URL}/b` },
    ]);
    expect(result).toEqual({ sent: 1, failed: ["someone@example.com"], held: { skipped: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(readSend(url, String(init?.body))?.to).toBe("ops@example.com");
    const [skipped] = await t.db
      .select()
      .from(sendLog)
      .where(eq(sendLog.recipient, "someone@example.com"));
    expect(skipped.status).toBe("skipped");
  });
});
