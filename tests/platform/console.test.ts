// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, camp, memberRole, operator, operatorLog } from "~/db/schema";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { isSend, readSend, type SentEmail, sendResponse, TEST_EMAIL_ENV } from "../helpers/mail";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, startWorker, type TestWorker } from "../helpers/worker";
import { AUD, accessKeys, TEAM } from "./access-keys";

// R16, R38, R41, R42: the operator console, through the real platform Worker.

const ROOT = fileURLToPath(new URL("../../platform/build/server", import.meta.url));
const DOMAIN = APP_HOST_SUFFIX;
const OPS = `https://ops.${DOMAIN}`;

let t: TestDb;
let z: Zulu;
let mf: Miniflare;
let camps: TestWorker;
let keys: Awaited<ReturnType<typeof accessKeys>>;
let token: string;
let samId: string;
const mail: SentEmail[] = [];

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  keys = await accessKeys();
  await t.db.insert(operator).values({ email: "casey@example.com", name: "Casey" });
  await t.db
    .insert(operator)
    .values({ email: "former@example.com", name: "Former", active: false });
  const admin = await invitePerson(t, "ada-admin@example.com", { legalName: "Ada Adminperson" });
  await t.db.insert(memberRole).values({ personId: admin.id, role: "admin" });
  samId = (await invitePerson(t, "sam@example.com", { legalName: "Samwise Membername" })).id;
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
        PLATFORM_DOMAIN: DOMAIN,
        ALERT_MAIL_FROM: "notify@mail.themecamp.test",
        ACCESS_TEAM_DOMAIN: TEAM,
        ACCESS_AUD: AUD,
        CONSOLE: "true",
        ...TEST_EMAIL_ENV,
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
  camps = await startWorker(t);
});
afterAll(async () => {
  await mf.dispose();
  await camps.dispose();
  await t.drop();
});
beforeEach(() => {
  mail.length = 0;
});

const ops = (
  path: string,
  jwt: string | null = token,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  mf.dispatchFetch(`${OPS}${path}`, {
    redirect: "manual",
    method: init.method,
    body: init.body,
    headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), ...(init.headers ?? {}) },
  });
const opsPost = (path: string, fields: Record<string, string>) =>
  ops(path, token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: OPS },
    body: new URLSearchParams(fields).toString(),
  });

describe("getting in", () => {
  it("shows an operator with a valid Access token the camps, with counts", async () => {
    const res = await ops("/ops");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("testcamp");
    expect(html).toContain("zulu");
  });

  it("serves what the console's client code fetches when navigating", async () => {
    // Clicking a link in the browser fetches the route manifest, then the route's data.
    const manifest = await ops(
      `/__manifest?paths=${encodeURIComponent(`/ops/camps/${z.campId},/ops/log`)}&version=x`,
    );
    // 200, or 204 when the client's version is stale; never refused or missing.
    expect([200, 204]).toContain(manifest.status);
    await manifest.text();
    for (const path of [`/ops/camps/${z.campId}.data`, "/ops/log.data", "/ops.data"]) {
      const res = await ops(path);
      expect([200, 204], path).toContain(res.status);
      await res.text();
    }
    // All of it behind the Access token.
    const noToken = await ops("/__manifest?paths=%2Fops&version=x", null);
    expect(noToken.status).toBe(403);
    await noToken.text();
  });

  it("sends the ops host's root to the console", async () => {
    const res = await ops("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${OPS}/ops`);
    await res.text();
  });

  it.each([
    ["no token", async () => null],
    ["the wrong audience", async () => keys.token("casey@example.com", { aud: ["other"] })],
    ["an expired token", async () => keys.token("casey@example.com", { exp: 1 })],
    ["a bad signature", async () => `${(await keys.token("casey@example.com")).slice(0, -4)}AAAA`],
    ["someone who isn't an operator", async () => keys.token("stranger@example.com")],
    ["a deactivated operator", async () => keys.token("former@example.com")],
  ])("refuses %s with a bare 403", async (_name, make) => {
    const res = await ops("/ops", await make());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  it("isn't on the public host, and the camp Worker doesn't serve the ops host", async () => {
    for (const path of ["/ops", "/ops.data", "/ops/log.data"]) {
      const pub = await mf.dispatchFetch(`https://${DOMAIN}${path}`, {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });
      expect(pub.status, path).toBe(404);
      await pub.text();
    }
    const viaCamps = await camps.fetch(new Request(`${OPS}/ops`));
    expect(viaCamps.status).toBe(404);
    await viaCamps.text();
  });
});

describe("counts only (R38)", () => {
  it("never shows a member's name, email or a camp's content", async () => {
    const pages = await Promise.all(
      ["/ops", `/ops/camps/${t.campId}`, `/ops/camps/${z.campId}`].map(async (path) => {
        const res = await ops(path);
        expect(res.status, path).toBe(200);
        return res.text();
      }),
    );
    const [list, detail, zulu] = pages;
    // Real pages with data, so the checks below aren't passing on an empty one.
    expect(list).toContain("zulu");
    expect(zulu).toContain("Active members");
    for (const html of [list, detail, zulu]) {
      for (const secret of [
        "Ada Adminperson",
        "ada-admin@example.com",
        "Samwise Membername",
        "sam@example.com",
        "Zzb Lead",
        "zzb-lead@example.com",
        "Zzb announcement",
        "Zzb guide text",
      ]) {
        expect(html, secret).not.toContain(secret);
      }
    }
    expect(detail).toContain("Active members");
  });
});

describe("usage (R74)", () => {
  it("shows how each camp uses the app as numbers and route ids, never who or what", async () => {
    const { signIn } = await import("../helpers/worker");
    const cookie = await signIn(camps, "ada-admin@example.com");
    for (const path of [`/people/${samId}`, "/people", "/no/such/page"]) {
      await (await camps.fetch(get(path, cookie))).text();
    }
    await new Promise((r) => setTimeout(r, 400));
    const all = await (await ops("/ops/usage")).text();
    const detail = await (await ops(`/ops/camps/${t.campId}`)).text();
    expect(all).toContain("testcamp");
    expect(all).toContain('href="/ops/usage"');
    expect(detail).toContain("Usage, last 30 days");
    expect(detail).toContain("routes/_app.lead.people.$id");
    expect(detail).toContain("routes/_app.lead.people._index");
    expect(detail).toContain("signed_in");
    for (const html of [all, detail]) {
      for (const secret of [
        samId,
        "Ada Adminperson",
        "ada-admin@example.com",
        "Samwise Membername",
        "sam@example.com",
        "/no/such/page",
        "Zzb",
      ]) {
        expect(html, secret).not.toContain(secret);
      }
    }
  });
});

describe("suspending and restoring (R16)", () => {
  it("needs a reason", async () => {
    const res = await opsPost(`/ops/camps/${t.campId}`, { intent: "suspend", reason: " " });
    expect(await res.text()).toContain("Give a reason");
    const [c] = await t.db.select().from(camp).where(eq(camp.id, t.campId));
    expect(c.status).toBe("active");
  });

  it("suspends the camp, logs it in both logs, and emails its Admins the reason", async () => {
    const res = await opsPost(`/ops/camps/${t.campId}`, {
      intent: "suspend",
      reason: "Unpaid pilot agreement",
    });
    expect(res.status).toBe(302);
    await res.text();
    const [c] = await t.db.select().from(camp).where(eq(camp.id, t.campId));
    expect(c.status).toBe("suspended");

    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, "camp_suspended"));
    expect(a).toMatchObject({ campId: t.campId, actorType: "operator", actorPersonId: null });
    expect(a.after).toEqual({ reason: "Unpaid pilot agreement" });
    const [l] = await t.db
      .select()
      .from(operatorLog)
      .where(eq(operatorLog.action, "camp_suspended"));
    expect(l).toMatchObject({ subjectCampId: t.campId, detail: "Unpaid pilot agreement" });

    await expect.poll(() => mail.length).toBe(1);
    expect(mail[0].to).toBe("ada-admin@example.com");
    expect(mail[0].subject).toContain("is suspended");
    expect(mail[0].body).toContain("Unpaid pilot agreement");
  });

  it("shows the suspension in the camp's Activity as done by Theme Camp App", async () => {
    // (The camp is suspended from the test above; reading is still allowed.)
    const cookie = await (await import("../helpers/worker")).signIn(camps, "ada-admin@example.com");
    const activity = await (await camps.fetch(get("/admin/activity", cookie))).text();
    expect(activity).toContain("Camp suspended. Reason: Unpaid pilot agreement");
    expect(activity).toContain("by Theme Camp App");
    const homeHtml = await (await camps.fetch(get("/", cookie))).text();
    expect(homeHtml).toContain("This camp is suspended");
  });

  it("restores it, with the same trail", async () => {
    const res = await opsPost(`/ops/camps/${t.campId}`, {
      intent: "restore",
      reason: "Sorted out",
    });
    expect(res.status).toBe(302);
    await res.text();
    const [c] = await t.db.select().from(camp).where(eq(camp.id, t.campId));
    expect(c.status).toBe("active");
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "camp_restored"));
    expect(rows).toHaveLength(1);
    await expect.poll(() => mail.length).toBe(1);
    expect(mail[0].subject).toContain("is restored");
  });
});

describe("guarding changes", () => {
  it("refuses a console change from another origin, or with no Origin at all", async () => {
    for (const origin of ["https://evil.example", null]) {
      const res = await ops(`/ops/camps/${z.campId}`, token, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(origin ? { origin } : {}),
        },
        body: new URLSearchParams({ intent: "limits", dailySendCap: "1" }).toString(),
      });
      expect(res.status, String(origin)).toBe(403);
      await res.text();
    }
    const [c] = await t.db.select().from(camp).where(eq(camp.id, z.campId));
    expect(c.dailySendCap).not.toBe(1);
  });

  it("answers 404 for a camp id that isn't one", async () => {
    for (const path of [
      "/ops/camps/not-a-uuid",
      "/ops/camps/00000000-0000-4000-8000-00000000dead",
    ]) {
      const res = await opsPost(path, { intent: "suspend", reason: "x" });
      expect(res.status, path).toBe(404);
      await res.text();
    }
  });
});

describe("limits and the operator log", () => {
  it("sets a camp's daily limit and pause, and logs it", async () => {
    const res = await opsPost(`/ops/camps/${z.campId}`, {
      intent: "limits",
      dailySendCap: "50",
      sendingPaused: "on",
    });
    expect(res.status).toBe(302);
    await res.text();
    const [c] = await t.db.select().from(camp).where(eq(camp.id, z.campId));
    expect(c).toMatchObject({ dailySendCap: 50, sendingPaused: true });
    const log = await (await ops("/ops/log")).text();
    expect(log).toContain("limits set");
    expect(log).toContain("daily cap 300 → 50");
  });

  it("records emergency database access by hand", async () => {
    const res = await opsPost("/ops/log", { campId: z.campId, detail: "Fixed a stuck invite row" });
    expect(res.status).toBe(302);
    await res.text();
    const [l] = await t.db
      .select()
      .from(operatorLog)
      .where(eq(operatorLog.kind, "database_access"));
    expect(l).toMatchObject({ subjectCampId: z.campId, detail: "Fixed a stuck invite row" });
    expect(await (await ops("/ops/log")).text()).toContain("Fixed a stuck invite row");
  });
});

describe("feedback (R65)", () => {
  it("shows feedback as plain text, with the camp, page, role and time but no one's identity", async () => {
    await t.client`
      insert into feedback (source_camp_id, path, role, message)
      values (${t.campId}, '/people/:id', 'member', ${"Broken <img src=x onerror=alert(1)> here\nline two"})`;
    const res = await ops("/ops/feedback");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("testcamp · /people/:id · member · ");
    expect(html).toContain("Broken &lt;img src=x onerror=alert(1)&gt; here\nline two");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('href="/ops/feedback"');
  });
});
