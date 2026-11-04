// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { user } from "~/db/auth-schema";
import {
  auditLog,
  camp,
  campSettings,
  dataRequest,
  memberRole,
  operator,
  person,
  supportGrant,
} from "~/db/schema";
import { runJobs } from "../../platform/app/jobs/run.server";
import { campTables } from "../../scripts/db-grants";
import { APP_HOST_SUFFIX, APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { isSend, readSend, type SentEmail, sendResponse, TEST_EMAIL_ENV } from "../helpers/mail";
import { TEST_CAMP_SLUG } from "../helpers/seed";
import { seedZulu, ZULU_SLUG, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";
import { AUD, accessKeys, TEAM } from "../platform/access-keys";

// R43–R45a, R51: data requests confirmed by the requester, then carried out from the console;
// camp deletion with its 30 days; login deletion; the full export; the privacy notice.

const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
const OPS = `https://ops.${APP_HOST_SUFFIX}`;
const ZULU = `https://${ZULU_SLUG}.${APP_HOST_SUFFIX}`;

let t: TestDb;
let z: Zulu;
let mf: Miniflare;
let w: TestWorker;
let token: string;
let admin: string;
const mail: SentEmail[] = [];

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  const keys = await accessKeys();
  await t.db.insert(operator).values({ email: "casey@example.com", name: "Casey" });
  token = await keys.token("casey@example.com");

  const files = (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(ROOT, f));
  files.sort((a, b) => Number(b.endsWith("/index.js")) - Number(a.endsWith("/index.js")));
  const url = new URL(t.runtimeUrl);
  url.username = "app_platform";
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: files.map((path) => ({ type: "ESModule" as const, path, contents: undefined })),
      modulesRoot: ROOT,
      compatibilityDate: "2026-09-23",
      compatibilityFlags: ["nodejs_compat"],
      hyperdrives: { HYPERDRIVE_PLATFORM: url.toString() },
      r2Buckets: ["FILES"],
      bindings: {
        PLATFORM_DOMAIN: APP_HOST_SUFFIX,
        ALERT_MAIL_FROM: "notify@mail.themecamp.test",
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: AUD,
        CONSOLE: "true",
        ...TEST_EMAIL_ENV,
        OPERATOR_EMAIL: "operator@example.com",
      },
      outboundService: async (req) => {
        const u = new URL(req.url);
        if (`${u.origin}${u.pathname}` === `${TEAM}/cdn-cgi/access/certs`)
          return Response.json(keys.jwks);
        if (isSend(req.url)) {
          mail.push(readSend(req.url, await req.text()) as SentEmail);
          return sendResponse("e1");
        }
        return new Response("blocked in tests", { status: 599 });
      },
    }),
  );
  await mf.ready;
  w = await startWorker(t);

  const a = await invitePerson(t, "admin@example.com", { legalName: "Ada Admin" });
  await t.db.insert(memberRole).values({ personId: a.id, role: "admin" });
  admin = await signIn(w, "admin@example.com");
  await w.fetch(get("/", admin));
  await t.db.insert(memberRole).values({ campId: z.campId, personId: z.leadId, role: "admin" });
});
afterAll(async () => {
  await mf.dispose();
  await w.dispose();
  await t.drop();
});
beforeEach(() => {
  mail.length = 0;
});

// In production the camp Worker's PHOTOS and the platform Worker's FILES are one bucket; the
// two test Workers each have their own, so objects are copied across where a test needs it.
const platformBucket = async () => (await mf.getR2Bucket("FILES")) as unknown as R2Bucket;
async function toPlatform(key: string, bytes: Uint8Array) {
  await (await platformBucket()).put(key, bytes);
}
async function platformToCamp(prefix: string) {
  const bucket = await platformBucket();
  for (const o of (await bucket.list({ prefix })).objects) {
    const obj = await bucket.get(o.key);
    if (obj) await w.putObject(o.key, new Uint8Array(await obj.arrayBuffer()), "application/zip");
  }
}

const console_ = (path: string, fields: Record<string, string>) =>
  mf.dispatchFetch(`${OPS}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      origin: OPS,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });

// Records a request in the console; returns the refusal text, or the emailed link's token.
async function tryRecord(campId: string, kind: string, email: string) {
  mail.length = 0;
  const res = await console_("/ops/requests", { intent: "record", campId, kind, email });
  const text = await res.text();
  if (res.status !== 302) return { error: text };
  await expect.poll(() => mail.length).toBe(1);
  const link = /https:\/\/\S+\/confirm\/request\/([A-Za-z0-9_-]+)/.exec(mail[0].body);
  if (!link) throw new Error("no link in the email");
  const [r] = await t.client`select id from data_request order by created_at desc limit 1`;
  return { token: link[1], requestId: r.id as string, link: link[0] };
}
async function record(campId: string, kind: string, email: string) {
  const r = await tryRecord(campId, kind, email);
  if ("error" in r) throw new Error(r.error);
  return r;
}

const carryOut = async (campId: string, requestId: string, kind: string) =>
  (await console_("/ops/requests", { intent: "carry_out", campId, requestId, kind })).text();

describe("recording a request", () => {
  it("only takes an export or camp deletion from one of the camp's Admins", async () => {
    const r = await tryRecord(t.campId, "export", "someone@example.com");
    expect("error" in r && r.error).toContain("isn&#x27;t an active Admin of this camp");
    const l = await tryRecord(t.campId, "delete_login", "nobody@example.com");
    expect("error" in l && l.error).toContain("No one in this camp signs in with that email");
  });

  it("emails a link on the camp's own site; viewing it confirms nothing, the button does", async () => {
    const r = await record(t.campId, "export", "admin@example.com");
    expect(mail[0].to).toBe("admin@example.com");
    expect(r.link.startsWith(`${APP_URL}/confirm/request/`)).toBe(true);

    const page = await w.fetch(get(`/confirm/request/${r.token}`));
    expect(await page.text()).toContain("Confirm your request");
    const [before] = await t.db.select().from(dataRequest).where(eq(dataRequest.id, r.requestId));
    expect(before.confirmedAt).toBeNull();
    expect(await carryOut(t.campId, r.requestId, "export")).toContain("hasn&#x27;t confirmed yet");

    // Not at another camp's site.
    const elsewhere = await w.fetch(post(`/confirm/request/${r.token}`, {}, { base: ZULU }));
    expect(await elsewhere.text()).toContain("doesn&#x27;t work any more");

    const confirm = await w.fetch(post(`/confirm/request/${r.token}`, {}));
    expect(await confirm.text()).toContain("Confirmed");
    const [after] = await t.db.select().from(dataRequest).where(eq(dataRequest.id, r.requestId));
    expect(after.confirmedAt).not.toBeNull();
  });

  it("refuses an expired link", async () => {
    const r = await record(t.campId, "export", "admin@example.com");
    await t.db
      .update(dataRequest)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(dataRequest.id, r.requestId));
    expect(await (await w.fetch(get(`/confirm/request/${r.token}`))).text()).toContain(
      "doesn&#x27;t work",
    );
    expect(await (await w.fetch(post(`/confirm/request/${r.token}`, {}))).text()).toContain(
      "doesn&#x27;t work any more",
    );
  });
});

describe("the full export (R43)", () => {
  it("needs a support grant, then gives the Admins a zip of this camp only", async () => {
    await toPlatform(
      `camps/${t.campId}/logo/00000000-0000-4000-8000-00000000aaaa.webp`,
      new Uint8Array([1, 2, 3]),
    );
    const r = await record(t.campId, "export", "admin@example.com");
    await w.fetch(post(`/confirm/request/${r.token}`, {}));
    expect(await carryOut(t.campId, r.requestId, "export")).toContain(
      "hasn&#x27;t granted support access",
    );

    const [a] = await t.db.select().from(person).where(eq(person.email, "admin@example.com"));
    await t.db
      .insert(supportGrant)
      .values({ createdByPersonId: a.id, expiresAt: new Date(Date.now() + 3600_000) });
    await carryOut(t.campId, r.requestId, "export");
    await platformToCamp(`camps/${t.campId}/exports/`);

    const list = await (await w.fetch(get("/admin/exports", admin))).text();
    const id = /\/admin\/exports\/([0-9a-f-]{36})/.exec(list)?.[1];
    expect(id).toBeTruthy();
    const res = await w.fetch(get(`/admin/exports/${id}`, admin));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/testcamp-export-/);
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(zip);
    expect(names).toContain("data/person.csv");
    expect(names).toContain("data/participation.csv");
    expect(names).toContain("files/logo/00000000-0000-4000-8000-00000000aaaa.webp");
    // Never secrets, never another camp.
    for (const secret of ["data/session.csv", "data/support_grant.csv", "data/data_request.csv"]) {
      expect(names).not.toContain(secret);
    }
    const everything = Object.values(zip)
      .map((b) => strFromU8(b))
      .join("\n");
    expect(everything).toContain("Ada Admin");
    expect(everything).not.toContain("Zzb");
    expect(everything).not.toContain(z.campId);
    // Burn years, so season-scoped tables have rows.
    expect(strFromU8(zip["data/burn.csv"]).split("\r\n").length).toBeGreaterThan(2);
  });

  it("refuses a camp whose files are too big to zip in one go, leaving nothing behind", async () => {
    const big = `camps/${t.campId}/passes/too-big.pdf`;
    // Just over EXPORT_MAX_BYTES (platform/app/lib/data-rights.server.ts).
    await toPlatform(big, new Uint8Array(60 * 1024 * 1024 + 1));
    const r = await record(t.campId, "export", "admin@example.com");
    await w.fetch(post(`/confirm/request/${r.token}`, {}));
    const [before] = await t.client`select count(*)::int as n from camp_export`;
    expect(await carryOut(t.campId, r.requestId, "export")).toContain("too many files");
    const [after] = await t.client`select count(*)::int as n from camp_export`;
    expect(after.n).toBe(before.n);
    const [open] = await t.db.select().from(dataRequest).where(eq(dataRequest.id, r.requestId));
    expect(open.completedAt).toBeNull();
    await (await platformBucket()).delete(big);
  });
});

describe("camp deletion (R44)", () => {
  it("closes the camp, can be undone within 30 days, and afterwards deletes everything", async () => {
    const r = await record(z.campId, "delete_camp", "zzb-lead@example.com");
    expect(r.link.startsWith(`${ZULU}/confirm/request/`)).toBe(true);
    await w.fetch(post(`/confirm/request/${r.token}`, {}, { base: ZULU }));
    await carryOut(z.campId, r.requestId, "delete_camp");
    const [c] = await t.db.select().from(camp).where(eq(camp.id, z.campId));
    expect(c.status).toBe("pending_deletion");
    expect((await w.fetch(get("/sign-in", undefined, ZULU))).status).toBe(404);

    // Restore within the 30 days.
    await console_(`/ops/camps/${z.campId}`, {
      intent: "restore_deleted",
      reason: "They changed their mind",
    });
    const [back] = await t.db.select().from(camp).where(eq(camp.id, z.campId));
    expect(back).toMatchObject({ status: "active", deleteAfter: null });
    expect((await w.fetch(get("/sign-in", undefined, ZULU))).status).toBe(200);

    // Delete again, let the 30 days pass, and run the hourly job.
    const again = await record(z.campId, "delete_camp", "zzb-lead@example.com");
    await w.fetch(post(`/confirm/request/${again.token}`, {}, { base: ZULU }));
    await carryOut(z.campId, again.requestId, "delete_camp");
    await toPlatform(
      `camps/${z.campId}/p/00000000-0000-4000-8000-00000000bbbb.webp`,
      new Uint8Array([9]),
    );
    await t.db
      .update(camp)
      .set({ deleteAfter: new Date(Date.now() - 1000) })
      .where(eq(camp.id, z.campId));
    const worker = (await mf.getWorker()) as unknown as {
      scheduled(options: { cron: string }): Promise<unknown>;
    };
    await worker.scheduled({ cron: "7 * * * *" });

    for (const table of await campTables(t.client)) {
      const [n] = await t.client.unsafe(
        `select count(*)::int as n from "${table}" where camp_id = $1`,
        [z.campId],
      );
      expect(n.n, table).toBe(0);
    }
    expect(await t.db.select().from(camp).where(eq(camp.id, z.campId))).toHaveLength(0);
    const left = await (await platformBucket()).list({ prefix: `camps/${z.campId}/` });
    expect(left.objects).toEqual([]);
    // Camp A untouched.
    expect(
      (await t.db.select().from(person).where(eq(person.campId, t.campId))).length,
    ).toBeGreaterThan(0);
    const [logged] = await t.client`select detail from operator_log where action = 'camp_deleted'`;
    expect(logged.detail).toContain(ZULU_SLUG);
  });
});

describe("login deletion (R45)", () => {
  it("deletes the login and anonymizes its people in every camp, keeping the history", async () => {
    const p = await invitePerson(t, "dual@example.com", {
      legalName: "Dora Dual",
      phone: "555-1234",
    });
    const cookie = await signIn(w, "dual@example.com");
    await w.fetch(get("/", cookie));
    const [linked] = await t.db.select().from(person).where(eq(person.id, p.id));
    // Issue #78: a mailing address goes too.
    await t.db
      .update(person)
      .set({
        mailingAddress: {
          line1: "1 Dora Way",
          line2: null,
          city: "Doraville",
          region: null,
          postalCode: null,
          country: "USA",
        },
      })
      .where(eq(person.id, p.id));
    // The same login is a member of a second camp.
    await t.db.insert(camp).values({ slug: "other", name: "Other Camp" }).onConflictDoNothing();
    const [other] = await t.db.select().from(camp).where(eq(camp.slug, "other"));
    await t.client`insert into burn (camp_id, year) values (${other.id}, 2027) on conflict do nothing`;
    await t.db
      .insert(campSettings)
      .values({ campId: other.id, currentYear: 2027 })
      .onConflictDoNothing();
    await t.db.insert(person).values({
      campId: other.id,
      legalName: "Dora Elsewhere",
      email: "dual@example.com",
      authUserId: linked.authUserId,
    });
    await t.db.insert(auditLog).values({
      actorPersonId: p.id,
      action: "person_edited",
      subjectType: "person",
      subjectId: p.id,
    });

    const r = await record(t.campId, "delete_login", "dual@example.com");
    await w.fetch(post(`/confirm/request/${r.token}`, {}));
    await carryOut(t.campId, r.requestId, "delete_login");

    expect(await t.db.select().from(user).where(eq(user.email, "dual@example.com"))).toHaveLength(
      0,
    );
    const people =
      await t.client`select camp_id, legal_name, email, phone, mailing_address, auth_user_id, active from person
      where legal_name like 'Dora%' or (legal_name = 'a deleted member')`;
    expect(
      people.every(
        (x) =>
          x.legal_name === "a deleted member" &&
          x.email === null &&
          x.phone === null &&
          x.mailing_address === null &&
          !x.active,
      ),
    ).toBe(true);
    expect(new Set(people.map((x) => x.camp_id))).toEqual(new Set([t.campId, other.id]));
    const [ev] =
      await t.client`select count(*)::int as n from auth_event where email = 'dual@example.com'`;
    expect(ev.n).toBe(0);
    const activity = await (await w.fetch(get("/admin/activity", admin))).text();
    expect(activity).toContain("a deleted member");
    expect(activity).not.toContain("Dora Dual");
    // Their session no longer works.
    expect((await w.fetch(get("/", cookie))).status).not.toBe(200);
  });
});

describe("the privacy notice (R51)", () => {
  it("shows once on a member's first sign-in, until they say Got it", async () => {
    await invitePerson(t, "newbie@example.com", { legalName: "Nia Newbie" });
    const cookie = await signIn(w, "newbie@example.com");
    const first = await (await w.fetch(get("/", cookie))).text();
    expect(first).toContain("Who can see what here");
    expect(first).toContain("only when one of the camp");
    // Not while the camp is suspended: it couldn't record the "Got it".
    await t.db.update(camp).set({ status: "suspended" }).where(eq(camp.id, t.campId));
    const suspended = await (await w.fetch(get("/", cookie))).text();
    expect(suspended).toContain("This camp is suspended");
    expect(suspended).not.toContain("Who can see what here");
    await t.db.update(camp).set({ status: "active" }).where(eq(camp.id, t.campId));
    const res = await w.fetch(post("/privacy-notice", {}, { cookie }));
    expect(res.status).toBe(302);
    const [n] = await t.db.select().from(person).where(eq(person.email, "newbie@example.com"));
    expect(n.privacyNoticeSeenAt).not.toBeNull();
    expect(await (await w.fetch(get("/", cookie))).text()).not.toContain("Who can see what here");
  });
});

describe("the hourly jobs", () => {
  it("end with the health check, which alerts the operator once", async () => {
    // (Zulu is gone by now: the camp deletion test above.)
    const worker = (await mf.getWorker()) as unknown as {
      scheduled(options: { cron: string }): Promise<unknown>;
    };
    await t.client`truncate platform_alert`;
    await t.db.update(camp).set({ sendingPaused: true }).where(eq(camp.id, t.campId));
    try {
      await worker.scheduled({ cron: "7 * * * *" });
      await worker.scheduled({ cron: "7 * * * *" });
      const alerts = mail.filter((m) => m.to === "operator@example.com");
      expect(alerts.map((m) => m.subject)).toEqual([`Email paused for ${TEST_CAMP_SLUG}`]);
      expect(await t.client`select key from platform_alert`).toEqual([
        { key: `paused:${TEST_CAMP_SLUG}` },
      ]);
    } finally {
      await t.db.update(camp).set({ sendingPaused: false }).where(eq(camp.id, t.campId));
    }
  });

  it("runs every job even when one fails", async () => {
    const ran: string[] = [];
    const results = await runJobs({} as never, {}, [
      {
        name: "broken",
        run: async () => {
          throw new Error("boom");
        },
      },
      { name: "fine", run: async () => ran.push("fine") },
    ]);
    expect(ran).toEqual(["fine"]);
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["broken", false],
      ["fine", true],
    ]);
  });
});
