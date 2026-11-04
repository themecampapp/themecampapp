// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { burn, camp, campSettings, emailSuppression, sendLog } from "~/db/schema";
import { createDb } from "~/lib/db.server";
import { sendMail } from "~/lib/mail.server";
import { type EmailEvent, handleEmailEvent } from "../../platform/app/lib/suppression.server";
import { emailWebhook } from "../../platform/app/webhooks/email.server";
import { APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  htmlToText,
  isSend,
  readSend,
  type SentEmail,
  sendResponse,
  TEST_EMAIL_ENV,
} from "../helpers/mail";
import { TEST_CAMP_ID } from "../helpers/seed";

// R36: the email webhook (platform Worker, fed by the provider's bounce and complaint events)
// suppresses addresses and pauses the camp that sent the mail when its rates pass the threshold.

const SECRET = "email-webhook-test-secret-that-is-long-enough";

let t: TestDb;
let platform: ReturnType<typeof postgres>;
let bravoId: string;

beforeAll(async () => {
  t = await createTestDb();
  const [c] = await t.db.insert(camp).values({ slug: "bravo", name: "Bravo Camp" }).returning();
  bravoId = c.id;
  await t.db.insert(burn).values({ campId: bravoId, year: 2027 });
  await t.db.insert(campSettings).values({ campId: bravoId, currentYear: 2027 });
  const url = new URL(t.runtimeUrl);
  url.username = "app_platform";
  platform = postgres(url.toString(), { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await platform.end();
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate send_log, email_suppression, email_webhook_event, platform_alert`;
  await t.db.update(camp).set({ sendingPaused: false }).where(sql`true`);
});
afterEach(() => vi.unstubAllGlobals());

// n sends from a camp (message ids a1..an to p1..pn@example.com), as the camp Worker logs them.
async function sends(n: number, campId = TEST_CAMP_ID, prefix = "a") {
  await t.client`
    insert into send_log (camp_id, kind, recipient, status, provider_id)
    select ${campId}, 'invite', 'p' || i || '@example.com', 'sent', ${prefix} || i
    from generate_series(1, ${n}) as i`;
}

let seq = 0;
const bounce = (messageId: string, recipient: string, permanent = true): EmailEvent => ({
  id: `exec_${++seq}`,
  kind: "bounce",
  messageId,
  recipient,
  permanent,
});
const complaint = (messageId: string, recipient: string): EmailEvent => ({
  id: `exec_${++seq}`,
  kind: "complaint",
  messageId,
  recipient,
  permanent: true,
});

describe("handling an event", () => {
  it("suppresses a hard bounce for every camp, and marks the camp's send", async () => {
    await sends(1);
    expect(await handleEmailEvent(platform, bounce("a1", "P1@example.com"))).toEqual({
      result: "recorded",
    });
    const [s] = await t.db.select().from(emailSuppression);
    expect(s).toMatchObject({ email: "p1@example.com", reason: "bounce" });
    const [row] = await t.db.select().from(sendLog).where(eq(sendLog.providerId, "a1"));
    expect(row.outcome).toBe("bounced");

    // Camp B can't mail it either.
    vi.stubGlobal("fetch", vi.fn());
    const bravo = createDb(t.runtimeUrl, bravoId);
    try {
      const env = {
        ...TEST_EMAIL_ENV,
        MAIL_FROM: "n@x.test",
        APP_URL,
        PRODUCT_NAME: "Theme Camp App",
      };
      expect(await sendMail(bravo.db, env, "invite", "p1@example.com", { url: "u" })).toBe(
        "suppressed",
      );
    } finally {
      await bravo.close();
    }
  });

  it("ignores soft bounces, and repeats", async () => {
    await sends(1);
    expect((await handleEmailEvent(platform, bounce("a1", "p1@example.com", false))).result).toBe(
      "ignored",
    );
    const c = complaint("a1", "p1@example.com");
    expect((await handleEmailEvent(platform, c)).result).toBe("recorded");
    await t.client`delete from email_suppression`;
    expect((await handleEmailEvent(platform, c)).result).toBe("duplicate");
    expect(await t.db.select().from(emailSuppression)).toHaveLength(0);
  });

  it("does nothing for an event that doesn't match a message sent to that address", async () => {
    await sends(25);
    // A real message id, but not this recipient; and an unknown id.
    for (const e of [
      complaint("a1", "someone-else@example.com"),
      complaint("zz", "p1@example.com"),
    ]) {
      expect((await handleEmailEvent(platform, e)).result).toBe("unmatched");
    }
    expect(await t.db.select().from(emailSuppression)).toHaveLength(0);
    const [c] = await t.db.select().from(camp).where(eq(camp.id, TEST_CAMP_ID));
    expect(c.sendingPaused).toBe(false);
  });

  it("pauses the camp that sent the message once its complaint rate passes the limit", async () => {
    await sends(25);
    await sends(25, bravoId, "b");
    const handled = await handleEmailEvent(platform, complaint("a3", "p3@example.com"));
    expect(handled).toMatchObject({
      result: "paused",
      slug: "testcamp",
      health: { sends: 25, complaints: 1 },
    });
    const paused = await t.db.select({ slug: camp.slug, paused: camp.sendingPaused }).from(camp);
    expect(Object.fromEntries(paused.map((c) => [c.slug, c.paused]))).toEqual({
      testcamp: true,
      bravo: false,
    });
    // Already paused: no second alert.
    expect((await handleEmailEvent(platform, complaint("a4", "p4@example.com"))).result).toBe(
      "recorded",
    );
  });

  it("pauses a camp whose bounce rate passes 4%", async () => {
    await sends(25);
    expect((await handleEmailEvent(platform, bounce("a1", "p1@example.com"))).result).toBe(
      "recorded",
    );
    // 2 of 25 is 8%.
    expect(await handleEmailEvent(platform, bounce("a2", "p2@example.com"))).toMatchObject({
      result: "paused",
      slug: "testcamp",
      health: { sends: 25, bounces: 2 },
    });
  });

  it("doesn't judge a camp on a handful of sends", async () => {
    await sends(5);
    await handleEmailEvent(platform, bounce("a1", "p1@example.com"));
    await handleEmailEvent(platform, bounce("a2", "p2@example.com"));
    const [c] = await t.db.select().from(camp).where(eq(camp.id, TEST_CAMP_ID));
    expect(c.sendingPaused).toBe(false);
  });
});

// What each provider posts for a bounce or complaint, and where (app/lib/email/). n numbers
// the event; a "hard" bounce is permanent.
type Hook = {
  path: (kind: "bounce" | "complaint") => string;
  body: (
    kind: "bounce" | "complaint",
    n: number,
    emailId: string,
    email: string,
    hard?: boolean,
  ) => unknown;
};
const HOOKS: Record<"plunk" | "postmark", Hook> = {
  // A Plunk workflow's default webhook payload; the address names the event.
  plunk: {
    path: (kind) => `/webhooks/email/plunk/${kind}`,
    body: (kind, n, emailId, email, hard = true) => ({
      contact: { email, subscribed: false, data: {} },
      workflow: { id: "wf_1", name: kind === "bounce" ? "Bounces" : "Complaints" },
      execution: { id: `exec_${n}`, startedAt: new Date().toISOString() },
      event: {
        emailId,
        messageId: "ses-1",
        sourceType: "TRANSACTIONAL",
        bounceType: kind === "bounce" ? (hard ? "Permanent" : "Transient") : undefined,
      },
    }),
  },
  // Postmark's bounce and spam complaint webhooks; the payload names the event.
  postmark: {
    path: () => "/webhooks/email/postmark",
    body: (kind, n, emailId, email, hard = true) => ({
      RecordType: kind === "bounce" ? "Bounce" : "SpamComplaint",
      MessageStream: "outbound",
      ID: n,
      Type: kind === "complaint" ? "SpamComplaint" : hard ? "HardBounce" : "SoftBounce",
      TypeCode: kind === "complaint" ? 512 : hard ? 1 : 4096,
      MessageID: emailId,
      Email: email,
      From: "notify@mail.themecamp.test",
      BouncedAt: new Date().toISOString(),
      Inactive: kind === "complaint" || hard,
      CanActivate: true,
    }),
  },
};

describe("the platform Worker's webhook", () => {
  const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
  const DOMAIN = "themecamp.test";
  let mf: Miniflare;
  const alerts: Array<SentEmail & { text: string }> = [];

  beforeAll(async () => {
    const files = (readdirSync(ROOT, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".js"))
      .map((f) => join(ROOT, f));
    files.sort((x, y) => Number(y.endsWith("/index.js")) - Number(x.endsWith("/index.js")));
    const url = new URL(t.runtimeUrl);
    url.username = "app_platform";
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: files.map((path) => ({ type: "ESModule" as const, path, contents: undefined })),
        modulesRoot: ROOT,
        compatibilityDate: "2026-09-23",
        compatibilityFlags: ["nodejs_compat"],
        hyperdrives: { HYPERDRIVE_PLATFORM: url.toString() },
        bindings: {
          PLATFORM_DOMAIN: DOMAIN,
          ALERT_MAIL_FROM: "notify@mail.themecamp.test",
          EMAIL_WEBHOOK_SECRET: SECRET,
          ...TEST_EMAIL_ENV,
          OPERATOR_EMAIL: "operator@example.com",
        },
        outboundService: async (req) => {
          if (isSend(req.url)) {
            const m = readSend(req.url, await req.text()) as SentEmail;
            alerts.push({ ...m, text: htmlToText(m.body) });
            return sendResponse("alert_1");
          }
          return new Response("blocked in tests", { status: 599 });
        },
      }),
    );
    await mf.ready;
  });
  afterAll(() => mf.dispose());
  afterEach(() => {
    alerts.length = 0;
  });

  function deliver(path: string, body: unknown, auth = `Bearer ${SECRET}`) {
    return mf.dispatchFetch(`https://${DOMAIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  // Every provider's address works, whichever the instance sends with: bounces for mail sent
  // through the old provider still arrive for a while after a switch.
  describe.each(Object.entries(HOOKS))("from %s", (_provider, hook) => {
    it("refuses a wrong secret and changes nothing", async () => {
      await sends(1);
      for (const auth of ["", "Bearer nope", `Bearer ${SECRET}x`, SECRET]) {
        const res = await deliver(
          hook.path("bounce"),
          hook.body("bounce", 1, "a1", "p1@example.com"),
          auth,
        );
        expect(res.status, auth).toBe(401);
        await res.text();
      }
      expect(await t.db.select().from(emailSuppression)).toHaveLength(0);
    });

    it("suppresses a hard bounce, and not a soft one", async () => {
      await sends(2);
      const soft = await deliver(
        hook.path("bounce"),
        hook.body("bounce", 1, "a1", "p1@example.com", false),
      );
      expect(soft.status).toBe(200);
      await soft.text();
      expect(await t.db.select().from(emailSuppression)).toHaveLength(0);
      const hard = await deliver(
        hook.path("bounce"),
        hook.body("bounce", 2, "a2", "p2@example.com"),
      );
      expect(hard.status).toBe(200);
      await hard.text();
      const [s] = await t.db.select().from(emailSuppression);
      expect(s).toMatchObject({ email: "p2@example.com", reason: "bounce" });
    });

    it("pauses the camp and emails the operator only the camp and the numbers", async () => {
      await sends(25);
      const res = await deliver(
        hook.path("complaint"),
        hook.body("complaint", 1, "a1", "p1@example.com"),
      );
      expect(res.status).toBe(200);
      await res.text();
      await vi.waitFor(() => expect(alerts).toHaveLength(1));
      expect(alerts[0].to).toBe("operator@example.com");
      expect(alerts[0].subject).toBe("Email paused for testcamp");
      expect(alerts[0].text).toContain("testcamp.themecamp.test");
      expect(alerts[0].text).not.toContain("p1@example.com");
      const [c] = await t.db.select().from(camp).where(eq(camp.id, TEST_CAMP_ID));
      expect(c.sendingPaused).toBe(true);
    });

    it("refuses a payload that isn't JSON or lacks the ids", async () => {
      const partial = hook.body("bounce", 1, "", "p1@example.com");
      for (const body of ["not json", partial]) {
        const res = await deliver(hook.path("bounce"), body);
        expect(res.status).toBe(400);
        await res.text();
      }
    });
  });

  it("takes Plunk's event from the address, and still takes Plunk's old address", async () => {
    await sends(1);
    const body = HOOKS.plunk.body("bounce", 1, "a1", "p1@example.com");
    for (const path of ["/webhooks/email/plunk/delivery", "/webhooks/email/plunk"]) {
      const res = await deliver(path, body);
      expect(res.status, path).toBe(404);
      await res.text();
    }
    const old = await deliver("/webhooks/plunk/bounce", body);
    expect(old.status).toBe(200);
    await old.text();
    const [s] = await t.db.select().from(emailSuppression);
    expect(s).toMatchObject({ email: "p1@example.com", reason: "bounce" });
  });

  it("takes Postmark's event from the payload, and ignores the ones it doesn't act on", async () => {
    await sends(1);
    const named = await deliver(
      "/webhooks/email/postmark/bounce",
      HOOKS.postmark.body("bounce", 1, "a1", "p1@example.com"),
    );
    expect(named.status).toBe(404);
    await named.text();
    // A delivery (if that trigger is on): accepted, so Postmark doesn't retry, and nothing done.
    const delivery = await deliver("/webhooks/email/postmark", {
      RecordType: "Delivery",
      ID: 7,
      MessageID: "a1",
      Recipient: "p1@example.com",
    });
    expect(delivery.status).toBe(200);
    await delivery.text();
    expect(await t.client`select * from email_webhook_event`).toHaveLength(0);
  });

  it("has no address for a provider it doesn't know", async () => {
    for (const path of ["/webhooks/email/sendgrid", "/webhooks/email/sendgrid/bounce"]) {
      const res = await deliver(path, {});
      expect(res.status, path).toBe(404);
      await res.text();
    }
  });

  it("is only on the public host", async () => {
    const res = await mf.dispatchFetch(`https://ops.${DOMAIN}/webhooks/email/plunk/bounce`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("the webhook secret's old name", () => {
  it("still works while EMAIL_WEBHOOK_SECRET isn't set", async () => {
    await sends(1);
    const url = new URL(t.runtimeUrl);
    url.username = "app_platform";
    const env = {
      PLUNK_WEBHOOK_SECRET: SECRET,
      HYPERDRIVE_PLATFORM: { connectionString: url.toString() },
      PLATFORM_DOMAIN: "themecamp.test",
    } as unknown as PlatformEnv;
    const ended: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => ended.push(p),
    } as unknown as ExecutionContext;
    const request = new Request("https://themecamp.test/webhooks/email/plunk/bounce", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(HOOKS.plunk.body("bounce", 1, "a1", "p1@example.com")),
    });
    const res = await emailWebhook(request, env, ctx, "plunk", "bounce");
    expect(res.status).toBe(200);
    await Promise.all(ended);
    expect(await t.db.select().from(emailSuppression)).toHaveLength(1);
  });
});
