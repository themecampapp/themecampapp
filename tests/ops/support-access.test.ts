// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberRole, operator, participation, supportGrant } from "~/db/schema";
import { APP_HOST_SUFFIX, APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, ZULU_SLUG } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";
import { AUD, accessKeys, TEAM } from "../platform/access-keys";

// R39, R40, R42a: support access, read-only. An Admin grants it; the operator opens the camp
// from the console; every page viewed is in the camp's Activity; nothing can change.

const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
const OPS = `https://ops.${APP_HOST_SUFFIX}`;
const ZULU = `https://${ZULU_SLUG}.${APP_HOST_SUFFIX}`;

let t: TestDb;
let mf: Miniflare;
let w: TestWorker;
let token: string;
let admin: string;
let admin2Email: string;
let lead: string;
let memberId: string;
let zuluId: string;

beforeAll(async () => {
  t = await createTestDb();
  zuluId = (await seedZulu(t)).campId;
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
      bindings: {
        PLATFORM_DOMAIN: APP_HOST_SUFFIX,
        ALERT_MAIL_FROM: "notify@mail.themecamp.test",
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: AUD,
        CONSOLE: "true",
      },
      outboundService: async (req) => {
        const u = new URL(req.url);
        if (`${u.origin}${u.pathname}` === `${TEAM}/cdn-cgi/access/certs`)
          return Response.json(keys.jwks);
        return new Response("blocked in tests", { status: 599 });
      },
    }),
  );
  await mf.ready;
  w = await startWorker(t);

  const a = await invitePerson(t, "admin@example.com", { legalName: "Ada Admin" });
  await t.db.insert(memberRole).values({ personId: a.id, role: "admin" });
  admin = await signIn(w, "admin@example.com");
  const a2 = await invitePerson(t, "admin2@example.com", { legalName: "Abe Admin" });
  await t.db.insert(memberRole).values({ personId: a2.id, role: "admin" });
  admin2Email = "admin2@example.com";
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  memberId = (await invitePerson(t, "member@example.com", { legalName: "Mo Member" })).id;
});
afterAll(async () => {
  await mf.dispose();
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`update support_grant set revoked_at = now(), ended_notified_at = now() where revoked_at is null`;
  w.emails.length = 0;
});

// The console's "Open the camp" button: returns the token the page would post to the camp.
async function openFromConsole(
  campId = t.campId,
): Promise<{ action: string; token: string } | string> {
  const res = await mf.dispatchFetch(`${OPS}/ops/camps/${campId}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      origin: OPS,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "intent=open_support",
  });
  const html = await res.text();
  const action = /<form[^>]*action="(https:[^"]+\/support\/enter)"/.exec(html)?.[1];
  const value = /<input type="hidden" name="token" value="([^"]+)"/.exec(html)?.[1];
  return action && value ? { action, token: value } : html;
}

// Posts the token as the console page does (from the ops origin); returns the support cookie.
async function enter(tokenValue: string, base = APP_URL, origin = OPS) {
  const res = await w.fetch(post("/support/enter", { token: tokenValue }, { base, origin }));
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("__Secure-support="));
  return { res, cookie };
}

const grant = (duration = "1d", cookie = admin) =>
  w.fetch(post("/admin/support", { duration }, { cookie }));

describe("granting", () => {
  it("lets an Admin grant read-only access, and emails every Admin", async () => {
    const res = await grant("1d");
    expect(res.status).toBe(302);
    const [g] = await t.db
      .select()
      .from(supportGrant)
      .where(sql`${supportGrant.revokedAt} is null`);
    const hours = (g.expiresAt.getTime() - g.createdAt.getTime()) / 3600_000;
    expect(Math.round(hours)).toBe(24);
    await expect
      .poll(() => w.emails.map((e) => e.to).sort())
      .toEqual(["admin2@example.com", "admin@example.com"]);
    expect(w.emails[0].text).toContain("read-only access");
    // Admins see a banner while it runs.
    expect(await (await w.fetch(get("/", admin))).text()).toContain(
      "Theme Camp App support can see this camp",
    );
    expect(admin2Email).toBeTruthy();
  });

  it("is for Admins only", async () => {
    expect((await w.fetch(get("/admin/support", lead))).status).toBe(403);
    expect((await grant("1d", lead)).status).toBe(403);
  });

  it("without a grant, the console can't open the camp", async () => {
    const opened = await openFromConsole();
    expect(typeof opened).toBe("string");
    expect(opened as string).toContain("hasn&#x27;t granted support access");
  });
});

describe("the operator's view", () => {
  it("opens the camp, sees what an Admin sees, and every page viewed is in Activity", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    expect(opened.action).toBe(`${APP_URL}/support/enter`);
    const { res, cookie } = await enter(opened.token);
    expect(res.status).toBe(302);
    expect(cookie).toBeTruthy();
    expect(res.headers.getSetCookie().join(";")).toMatch(/HttpOnly; Secure; SameSite=Strict/);

    const home = await (await w.fetch(get("/", cookie))).text();
    expect(home).toContain("Theme Camp App support view, read-only");
    const people = await w.fetch(get(`/people/${memberId}`, cookie));
    expect(people.status).toBe(200);
    expect(await people.text()).toContain("Mo Member");

    await expect
      .poll(async () =>
        (await t.db.select().from(auditLog).where(eq(auditLog.action, "support_view"))).map(
          (r) => (r.after as { path: string }).path,
        ),
      )
      .toEqual(expect.arrayContaining(["/", `/people/${memberId}`]));
    const activity = await (await w.fetch(get("/admin/activity?who=operator", admin))).text();
    // The actor is shown as the instance, beside the neutral label (open-source plan 3.5).
    expect(activity).toContain(`Support viewed /people/${memberId}`);
    expect(activity).toContain("by Theme Camp App");
    expect(activity).not.toContain("Support access granted");
  });

  it("can open every page without a server error (support is no one's person)", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    const failures: string[] = [];
    for (const path of [
      "/",
      "/rsvp",
      "/profile",
      "/tickets/request",
      "/volunteer",
      "/yearbook",
      "/dues",
      "/guides",
      "/guides/welcome",
      "/people",
      `/people/${memberId}`,
      `/people/${memberId}/rsvp`,
      "/people/export",
      "/roster",
      "/tickets",
      "/saps",
      "/volunteers",
      "/inquiries",
      "/queue",
      "/announcements",
      "/dates",
      "/guide-editor",
      "/admin",
      "/admin/settings",
      "/admin/features",
      "/admin/emails",
      "/admin/positions",
      "/admin/saps",
      "/admin/activity",
      "/admin/logs",
      "/admin/support",
    ]) {
      const res = await w.fetch(get(path, cookie));
      if (res.status >= 500) failures.push(`${path} ${res.status}`);
      await res.arrayBuffer();
    }
    expect(failures).toEqual([]);
  });

  it("logs guide pages support opens too", async () => {
    await t.client`insert into guide (camp_id, slug, title, body, visibility, published)
      values (${t.campId}, 'lead-notes', 'Lead notes', 'x', 'leads', true) on conflict do nothing`;
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    expect((await w.fetch(get("/guides/lead-notes", cookie))).status).toBe(200);
    await expect
      .poll(async () =>
        (await t.db.select().from(auditLog).where(eq(auditLog.action, "support_view"))).map(
          (r) => (r.after as { path: string }).path,
        ),
      )
      .toContain("/guides/lead-notes");
  });

  it("lets the console's page post the token to the camp (its security policy allows it)", async () => {
    await grant("1d");
    const res = await mf.dispatchFetch(`${OPS}/ops/camps/${t.campId}`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    await res.text();
    expect(res.headers.get("Content-Security-Policy")).toContain(
      `form-action 'self' https://*.${APP_HOST_SUFFIX}`,
    );
    // And the browser sends its Origin with that cross-origin POST ("no-referrer" would make
    // it "Origin: null", which the camp Worker refuses).
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin");
    // Everywhere else, forms post only to their own origin.
    const camp = await w.fetch(get("/", admin));
    await camp.text();
    expect(camp.headers.get("Content-Security-Policy")).toMatch(/form-action 'self'$/);
  });

  it("can't download the camp's member list", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    const res = await w.fetch(get("/people/export", cookie));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Mo Member");
  });

  it("can't change anything", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    const before = await t.db.select().from(participation);
    for (const [path, fields] of [
      ["/rsvp", { intent: "going" }],
      ["/admin/support", { intent: "revoke" }],
      ["/sign-out", {}],
    ] as const) {
      const res = await w.fetch(post(path, fields, { cookie }));
      expect(res.status, path).toBe(403);
      expect(await res.text()).toBe("Support access is read-only.");
    }
    expect(await t.db.select().from(participation)).toEqual(before);
  });

  it("leaves from the page's button (a client-side post to /support/leave.data)", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    // Other client-side writes are still refused.
    const rsvp = await w.fetch(post("/rsvp.data", { intent: "going" }, { cookie }));
    expect(rsvp.status).toBe(403);
    await rsvp.text();
    const res = await w.fetch(post("/support/leave.data", {}, { cookie }));
    expect(res.status).not.toBe(403);
    await res.text();
    expect(res.headers.getSetCookie().join(";")).toMatch(/__Secure-support=;/);
  });

  it("refuses a replayed token, and a token taken to another camp", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const atZulu = await enter(opened.token, ZULU);
    expect(atZulu.res.status).toBe(403);
    expect(atZulu.cookie).toBeUndefined();
    expect((await enter(opened.token)).res.status).toBe(302);
    const again = await enter(opened.token);
    expect(again.res.status).toBe(403);
    expect(again.cookie).toBeUndefined();
  });

  it("lets only one of two simultaneous uses of a token in", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const results = await Promise.all([enter(opened.token), enter(opened.token)]);
    expect(results.map((r) => r.res.status).sort()).toEqual([302, 403]);
    expect(results.filter((r) => r.cookie)).toHaveLength(1);
  });

  it("refuses the token with a null Origin (what a no-referrer page would send)", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const res = await w.fetch(post("/support/enter", { token: opened.token }, { origin: "null" }));
    expect(res.status).toBe(403);
    await res.text();
  });

  it("accepts the token only from the console's origin", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const res = await w.fetch(post("/support/enter", { token: opened.token }, { origin: ZULU }));
    expect(res.status).toBe(403);
    await res.text();
  });

  it("won't let a support cookie from one camp into another", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    const res = await w.fetch(get("/", cookie, ZULU));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Zzb");
    expect(zuluId).toBeTruthy();
  });
});

describe("replacing", () => {
  it("tells the Admins the old grant ended when a new one replaces it, and keeps one running", async () => {
    await grant("1d");
    w.emails.length = 0;
    await Promise.all([grant("3d"), grant("7d")]);
    await expect.poll(() => w.emails.length).toBe(8); // per new grant: ended + started, to 2 Admins
    const running = await t.db
      .select()
      .from(supportGrant)
      .where(sql`${supportGrant.revokedAt} is null and ${supportGrant.expiresAt} > now()`);
    expect(running).toHaveLength(1);
  });
});

describe("ending", () => {
  it("revoking ends access at once, clears the cookie, and emails the Admins", async () => {
    await grant("1d");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    w.emails.length = 0;
    expect(
      (await w.fetch(post("/admin/support", { intent: "revoke" }, { cookie: admin }))).status,
    ).toBe(302);
    await expect.poll(() => w.emails.length).toBe(2);
    expect(w.emails[0].text).toContain("can no longer see");

    const res = await w.fetch(get("/", cookie));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().join(";")).toMatch(/__Secure-support=; .*Max-Age=0/);
    expect(await res.text()).toContain("Support access has ended");
  });

  it("expiry ends access, and the Admins are told once", async () => {
    await grant("1h");
    const opened = await openFromConsole();
    if (typeof opened === "string") throw new Error(opened);
    const { cookie } = await enter(opened.token);
    await t.client`update support_grant set expires_at = now() - interval '1 minute' where revoked_at is null`;
    expect((await w.fetch(get("/", cookie))).status).toBe(403);

    w.emails.length = 0;
    await (await w.fetch(get("/admin/support", admin))).text();
    await (await w.fetch(get("/admin/support", admin))).text();
    await expect.poll(() => w.emails.length).toBe(2); // one email to each Admin, once
    const expired = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "support_expired"));
    expect(expired).toHaveLength(1);
  });

  it("opens in a suspended camp, with an expired grant left for the hourly job (#84)", async () => {
    await grant("1h");
    await t.client`update support_grant set expires_at = now() - interval '1 minute' where revoked_at is null`;
    await t.client`update camp set status = 'suspended' where id = ${t.campId}`;
    try {
      const res = await w.fetch(get("/admin/support", admin));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain("Support access");
    } finally {
      await t.client`update camp set status = 'active' where id = ${t.campId}`;
    }
  });
});
