// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, camp, memberRole, person, supportGrant } from "~/db/schema";
import { checkHealth, SIGN_IN_FAILURES } from "../../platform/app/jobs/health.server";
import { settleSupportGrants } from "../../platform/app/jobs/support-grants.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { fakeSend, TEST_EMAIL_ENV } from "../helpers/mail";
import { TEST_CAMP_SLUG } from "../helpers/seed";
import { seedZulu, ZULU_SLUG, type Zulu } from "../helpers/two-camps";

// R55 and R39: the hourly health check emails the operator about what's wrong, once a day
// while it stays wrong; expired support grants are settled and the camp's Admins told.

const env = {
  PLATFORM_DOMAIN: "themecamp.test",
  ALERT_MAIL_FROM: "notify@mail.themecamp.test",
  ...TEST_EMAIL_ENV,
  OPERATOR_EMAIL: "operator@example.com",
  PRODUCT_NAME: "Theme Camp App",
} as PlatformEnv;

let t: TestDb;
let z: Zulu;
let platform: ReturnType<typeof postgres>;
let sent: Array<{ to: string; subject: string; body: string }>;
let providerUp: boolean;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  const url = new URL(t.runtimeUrl);
  url.username = "app_platform";
  // As the platform Worker connects: without fetching types (arrays aren't available).
  platform = postgres(url.toString(), { max: 1, fetch_types: false, onnotice: () => {} });
});
afterAll(async () => {
  await platform.end();
  await t.drop();
});
beforeEach(async () => {
  sent = [];
  providerUp = true;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    providerUp ? fakeSend((m) => sent.push(m))(url, init) : new Response("down", { status: 503 }),
  );
  await t.client`truncate platform_alert, send_log, auth_event`;
  await t.db.update(camp).set({ sendingPaused: false }).where(sql`true`);
});
afterEach(() => vi.unstubAllGlobals());

const run = (failed: Array<{ name: string; error?: string }> = []) =>
  checkHealth(platform, env, failed);
const operatorMail = () => sent.filter((m) => m.to === env.OPERATOR_EMAIL);

describe("the health check", () => {
  it("sends nothing when all is well", async () => {
    expect(await run()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("alerts once about a paused camp, again after a day, and at once if it comes back", async () => {
    await t.db.update(camp).set({ sendingPaused: true }).where(eq(camp.slug, ZULU_SLUG));
    expect(await run()).toEqual([`paused:${ZULU_SLUG}`]);
    expect(operatorMail()).toHaveLength(1);
    expect(operatorMail()[0].subject).toBe(`Email paused for ${ZULU_SLUG}`);
    expect(operatorMail()[0].body).toContain(`${ZULU_SLUG}.themecamp.test`);

    // Still paused an hour later: not again.
    expect(await run()).toEqual([]);
    expect(operatorMail()).toHaveLength(1);

    // A day later, still paused: again.
    await t.client`update platform_alert set last_sent_at = now() - interval '25 hours'`;
    expect(await run()).toEqual([`paused:${ZULU_SLUG}`]);
    expect(operatorMail()).toHaveLength(2);

    // Resolved, then paused again: the alert was cleared, so it goes out at once.
    await t.db.update(camp).set({ sendingPaused: false }).where(eq(camp.slug, ZULU_SLUG));
    expect(await run()).toEqual([]);
    expect(await t.client`select * from platform_alert`).toHaveLength(0);
    await t.db.update(camp).set({ sendingPaused: true }).where(eq(camp.slug, ZULU_SLUG));
    expect(await run()).toEqual([`paused:${ZULU_SLUG}`]);
    expect(operatorMail()).toHaveLength(3);
  });

  it("tries again next hour when the alert email fails", async () => {
    await t.db.update(camp).set({ sendingPaused: true }).where(eq(camp.slug, ZULU_SLUG));
    providerUp = false;
    expect(await run()).toEqual([]);
    expect(await t.client`select * from platform_alert`).toHaveLength(0);
    providerUp = true;
    expect(await run()).toEqual([`paused:${ZULU_SLUG}`]);
  });

  it("alerts about one camp's failing email and sign-ins, in one message, naming only it", async () => {
    await t.client`
      insert into send_log (camp_id, kind, recipient, status)
      select ${z.campId}, 'invite', 'p' || i || '@example.com',
        case when i <= 4 then 'failed' else 'sent' end
      from generate_series(1, 10) as i`;
    await t.client`
      insert into auth_event (camp_id, event, email)
      select ${z.campId}, 'sign_in_failed', 'x@example.com'
      from generate_series(1, ${SIGN_IN_FAILURES})`;
    // The test camp has a few of each: under the thresholds.
    await t.client`
      insert into send_log (camp_id, kind, recipient, status)
      values (${t.campId}, 'invite', 'a@example.com', 'failed')`;
    await t.client`
      insert into auth_event (camp_id, event) values (${t.campId}, 'sign_in_failed')`;
    // Old ones don't count.
    await t.client`
      insert into auth_event (camp_id, event, created_at)
      select ${t.campId}, 'sign_in_failed', now() - interval '2 hours'
      from generate_series(1, 20)`;

    expect((await run()).sort()).toEqual([
      `send_failures:${ZULU_SLUG}`,
      `sign_in_failures:${ZULU_SLUG}`,
    ]);
    expect(operatorMail()).toHaveLength(1);
    const [mail] = operatorMail();
    expect(mail.subject).toBe("Theme Camp App: 2 problems need a look");
    expect(mail.body).toContain("4 of 10 emails");
    expect(mail.body).not.toContain(TEST_CAMP_SLUG);
    expect(mail.body).not.toContain("x@example.com");
  });

  it("alerts when the isolation probe finds a broken policy", async () => {
    await t.client.unsafe(`drop policy camp_isolation on inquiry_note`);
    await t.client.unsafe(`create policy camp_isolation on inquiry_note using (true)`);
    try {
      expect(await run()).toEqual(["isolation"]);
      expect(operatorMail()[0].subject).toBe("Camp isolation problem");
      expect(operatorMail()[0].body).toContain("inquiry_note");
    } finally {
      await t.client.unsafe(`select enable_camp_rls('inquiry_note')`);
    }
    expect(await run()).toEqual([]);
  });

  it("alerts about a scheduled job that failed", async () => {
    expect(await run([{ name: "expire_exports", error: "R2 unavailable" }])).toEqual([
      "job:expire_exports",
    ]);
    expect(operatorMail()[0].body).toContain("R2 unavailable");
  });
});

describe("settling expired support grants", () => {
  it("tells the Admins once, audits it, and leaves suspended and demo camps alone", async () => {
    const [admin] = await t.db
      .insert(person)
      .values({ legalName: "Ada Admin", email: "Ada@Example.com" })
      .returning();
    await t.db.insert(memberRole).values({ personId: admin.id, role: "admin" });
    const past = new Date(Date.now() - 60_000);
    const [ended] = await t.db
      .insert(supportGrant)
      .values({ createdByPersonId: admin.id, expiresAt: past })
      .returning();
    // Still running, and revoked (the revoke already told them): neither is settled.
    await t.db.insert(supportGrant).values([
      { createdByPersonId: admin.id, expiresAt: new Date(Date.now() + 3600_000) },
      { createdByPersonId: admin.id, expiresAt: past, revokedAt: past },
    ]);
    // Zulu's grant has run out too, but Zulu is suspended.
    await t.db
      .insert(supportGrant)
      .values({ campId: z.campId, createdByPersonId: z.leadId, expiresAt: past });
    await t.db.update(camp).set({ status: "suspended" }).where(eq(camp.id, z.campId));
    try {
      expect(await settleSupportGrants(platform, env)).toBe(1);
      expect(sent.map((m) => m.to)).toEqual(["ada@example.com"]);
      expect(sent[0].subject).toBe("Theme Camp App support's access to Test Camp has ended");
      expect(sent[0].body).toContain(
        `https://${TEST_CAMP_SLUG}.themecamp.test/admin/activity?who=operator`,
      );
      const [g] = await t.db.select().from(supportGrant).where(eq(supportGrant.id, ended.id));
      expect(g.endedNotifiedAt).not.toBeNull();
      const audits = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "support_expired"));
      expect(audits.map((a) => a.subjectId)).toEqual([ended.id]);

      // Once.
      expect(await settleSupportGrants(platform, env)).toBe(0);
      expect(sent).toHaveLength(1);
      const [zg] = await t.db.select().from(supportGrant).where(eq(supportGrant.campId, z.campId));
      expect(zg.endedNotifiedAt).toBeNull();

      // Nor the demo camp.
      await t.db.update(camp).set({ status: "active", kind: "demo" }).where(eq(camp.id, z.campId));
      expect(await settleSupportGrants(platform, env)).toBe(0);
    } finally {
      await t.db.update(camp).set({ status: "active", kind: "camp" }).where(eq(camp.id, z.campId));
    }
  });
});
