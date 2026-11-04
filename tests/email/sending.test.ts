// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { burn, camp, campSettings, emailSuppression, sendLog } from "~/db/schema";
import { createDb, type Db } from "~/lib/db.server";
import { heldNotice, notSentError, sendMail, sendMailBatch } from "~/lib/mail.server";
import { APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  EMAIL_PROVIDER,
  htmlToText,
  readSend,
  type SentEmail,
  sendResponse,
  TEST_EMAIL_ENV,
} from "../helpers/mail";
import { TEST_CAMP_ID } from "../helpers/seed";

// Every email goes through the same checks (R14, R34, R36). These run as app_runtime, acting
// for one camp at a time, as the camp Worker does.

type Sent = SentEmail & { text: string };

let t: TestDb;
let a: { db: Db; close: () => Promise<unknown> };
let b: { db: Db; close: () => Promise<unknown> };
let bravoId: string;
let sent: Sent[];
const env = {
  ...TEST_EMAIL_ENV,
  MAIL_FROM: "notify@mail.themecamp.test",
  AUTH_MAIL_FROM: "signin@auth.themecamp.test",
  PRODUCT_NAME: "Theme Camp App",
  APP_URL,
};

beforeAll(async () => {
  t = await createTestDb();
  const [c] = await t.db.insert(camp).values({ slug: "bravo", name: "Bravo Camp" }).returning();
  bravoId = c.id;
  await t.db.insert(burn).values({ campId: bravoId, year: 2027 });
  await t.db.insert(campSettings).values({ campId: bravoId, currentYear: 2027 });
  a = createDb(t.runtimeUrl, TEST_CAMP_ID);
  b = createDb(t.runtimeUrl, bravoId);
});
afterAll(async () => {
  await a.close();
  await b.close();
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate send_log, email_suppression`;
  await t.db
    .update(camp)
    .set({ status: "active", sendingPaused: false, dailySendCap: 300 })
    .where(sql`true`);
  await t.db
    .update(campSettings)
    .set({ displayName: null, contactEmail: "hello@testcamp.example" })
    .where(eq(campSettings.campId, TEST_CAMP_ID));
  sent = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = readSend(url, String(init?.body));
      expect(body, url).not.toBeNull();
      sent.push({ ...(body as SentEmail), text: htmlToText((body as SentEmail).body) });
      return sendResponse(`msg_${++n}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const logFor = (recipient: string) =>
  t.db.select().from(sendLog).where(eq(sendLog.recipient, recipient));

describe("what an email says", () => {
  it("comes from the camp, via the platform, with the camp's reply-to and a footer", async () => {
    expect(
      await sendMail(a.db, env, "invite", "nova@example.com", { url: `${APP_URL}/sign-in` }),
    ).toBe("sent");
    const [m] = sent;
    expect(m.from).toEqual({
      name: "Test Camp via Theme Camp App",
      email: "notify@mail.themecamp.test",
    });
    expect(m.reply).toBe("hello@testcamp.example");
    // Only the app's own link is clickable.
    expect(m.body).toContain(`<a href="${APP_URL}/sign-in">`);
    expect(m.text).toContain(`${APP_URL}/sign-in`);
    expect(m.text).toMatch(
      /Sent by Test Camp through Theme Camp App\. You're getting this because a camp lead invited you/,
    );
    const [row] = await logFor("nova@example.com");
    expect(row).toMatchObject({ status: "sent", providerId: "msg_1" });
  });

  it("sends sign-in links from the separate account address", async () => {
    await sendMail(a.db, env, "magic_link", "nova@example.com", { url: `${APP_URL}/x` });
    expect(sent[0].from.email).toBe("signin@auth.themecamp.test");
  });

  it("keeps the other camp's name and no reply-to when it has no contact", async () => {
    await sendMail(b.db, env, "invite", "nova@example.com", { url: "https://bravo.x/sign-in" });
    expect(sent[0].from.name).toBe("Bravo Camp via Theme Camp App");
    expect(sent[0].reply).toBeUndefined();
    expect(sent[0].text).toContain("Sent by Bravo Camp");
  });
});

describe("the checks before sending", () => {
  it("never mails a suppressed address, from any camp, and logs it", async () => {
    await t.db.insert(emailSuppression).values({ email: "gone@example.com", reason: "bounce" });
    expect(await sendMail(a.db, env, "invite", "Gone@Example.com", { url: "u" })).toBe(
      "suppressed",
    );
    expect(await sendMail(b.db, env, "magic_link", "gone@example.com", { url: "u" })).toBe(
      "suppressed",
    );
    expect(sent).toHaveLength(0);
    const rows = await t.client`select status, camp_id from send_log order by created_at`;
    expect(rows.map((r) => r.status)).toEqual(["suppressed", "suppressed"]);
  });

  it("holds a paused camp's mail, but still sends its sign-in links", async () => {
    await t.db.update(camp).set({ sendingPaused: true }).where(eq(camp.id, TEST_CAMP_ID));
    expect(await sendMail(a.db, env, "invite", "nova@example.com", { url: "u" })).toBe("paused");
    expect(await sendMail(a.db, env, "magic_link", "nova@example.com", { url: "u" })).toBe("sent");
    expect(await sendMail(b.db, env, "invite", "nova@example.com", { url: "u" })).toBe("sent");
    expect(sent).toHaveLength(2);
  });

  it("never sends from the demo camp", async () => {
    await t.db.update(camp).set({ kind: "demo" }).where(eq(camp.id, TEST_CAMP_ID));
    try {
      expect(await sendMail(a.db, env, "magic_link", "nova@example.com", { url: "u" })).toBe(
        "skipped",
      );
      expect(sent).toHaveLength(0);
    } finally {
      await t.db.update(camp).set({ kind: "camp" }).where(eq(camp.id, TEST_CAMP_ID));
    }
  });

  it("tells the Lead why mail was held", () => {
    expect(notSentError("capped").data).toEqual({ reason: "daily_limit" });
    expect(notSentError("paused").data).toEqual({ reason: "sending_paused" });
    // Not "suppressed": that would tell one camp about another camp's bounces.
    expect(notSentError("suppressed").data).toEqual({ reason: "send_failed" });
    expect(notSentError("failed").init?.status).toBe(502);
    expect(heldNotice({ capped: 2 })).toMatch(/2 held back: this camp reached today's email limit/);
    expect(heldNotice({})).toBeNull();
  });

  it("sends only sign-in links while a camp is suspended", async () => {
    await t.db.update(camp).set({ status: "suspended" }).where(eq(camp.id, TEST_CAMP_ID));
    expect(await sendMail(a.db, env, "invite", "nova@example.com", { url: "u" })).toBe("skipped");
    expect(await sendMail(a.db, env, "magic_link", "nova@example.com", { url: "u" })).toBe("sent");
    expect(sent.map((m) => m.from.email)).toEqual(["signin@auth.themecamp.test"]);
  });

  it("stops invites and nudges at the camp's daily limit, and only for that camp", async () => {
    await t.db.update(camp).set({ dailySendCap: 3 }).where(eq(camp.id, TEST_CAMP_ID));
    const five = [1, 2, 3, 4, 5].map((i) => ({ to: `p${i}@example.com`, url: "u" }));
    const first = await sendMailBatch(a.db, env, "invite", five);
    expect(first).toMatchObject({ sent: 3, held: { capped: 2 } });
    expect(first.failed).toEqual(["p4@example.com", "p5@example.com"]);
    expect(await sendMail(a.db, env, "rsvp_nudge", "p6@example.com", { url: "u" })).toBe("capped");
    // Transactional mail isn't capped.
    expect(await sendMail(a.db, env, "sap_approved", "p6@example.com", { url: "u" })).toBe("sent");
    // Another camp has its own limit.
    expect(await sendMail(b.db, env, "invite", "p7@example.com", { url: "u" })).toBe("sent");
    const [capped] = await logFor("p4@example.com");
    expect(capped).toMatchObject({ status: "capped" });
  });

  it("logs a provider error as failed, with no message id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    expect(await sendMail(a.db, env, "invite", "nova@example.com", { url: "u" })).toBe("failed");
    const batch = await sendMailBatch(a.db, env, "invite", [{ to: "x@example.com", url: "u" }]);
    expect(batch).toEqual({ sent: 0, failed: ["x@example.com"], held: {} });
    const rows = await t.client`select status, error, provider_id from send_log`;
    expect(rows).toEqual([
      { status: "failed", error: `${EMAIL_PROVIDER} 500`, provider_id: null },
      { status: "failed", error: `${EMAIL_PROVIDER} 500`, provider_id: null },
    ]);
  });

  it("counts each copy of a shared address on its own against the limit", async () => {
    await t.db.update(camp).set({ dailySendCap: 2 }).where(eq(camp.id, TEST_CAMP_ID));
    const result = await sendMailBatch(a.db, env, "rsvp_nudge", [
      { to: "one@example.com", url: "u" },
      { to: "shared@example.com", url: "u" },
      { to: "shared@example.com", url: "u" },
    ]);
    expect(result).toMatchObject({ sent: 2, failed: ["shared@example.com"], held: { capped: 1 } });
    expect(sent.map((m) => m.to)).toEqual(["one@example.com", "shared@example.com"]);
  });

  it("stores each bulk message's Plunk id", async () => {
    await sendMailBatch(a.db, env, "invite", [
      { to: "x1@example.com", url: "u" },
      { to: "x2@example.com", url: "u" },
    ]);
    const rows = await t.client`select recipient, provider_id from send_log order by recipient`;
    expect(rows.map((r) => r.provider_id)).toEqual(["msg_1", "msg_2"]);
  });
});
