// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, camp, campSettings, invite, person, sendLog } from "~/db/schema";
import { getDb, getWriteDb } from "~/lib/context.server";
import { APP_HOST_SUFFIX, APP_URL, makeContext } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { startWorker, type TestWorker } from "../helpers/worker";

// Requests through the real camp Worker (in workerd, connecting as app_runtime), with the
// default test camp ("testcamp") and a second camp added here.
let t: TestDb;
let w: TestWorker;
let campB: string;
const HOST_B = `https://bravo.${APP_HOST_SUFFIX}`;

// drizzle wraps the database error; the cause is Postgres refusing the write.
const readOnlyRefusal = (e: unknown) =>
  /read-only transaction/.test(String((e as { cause?: unknown }).cause ?? e));

const fetchUrl = (url: string, init: RequestInit = {}) =>
  w.fetch(new Request(url, { redirect: "manual", ...init }));

beforeAll(async () => {
  t = await createTestDb();
  const [b] = await t.db.insert(camp).values({ slug: "bravo", name: "Bravo" }).returning();
  campB = b.id;
  await t.db.insert(burn).values({ campId: campB, year: 2027 });
  await t.db.insert(campSettings).values({ campId: campB, currentYear: 2027 });
  w = await startWorker(t);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("host resolution", () => {
  it("serves a camp at its own address", async () => {
    const res = await fetchUrl(`${APP_URL}/sign-in`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it("ignores case, the port and a trailing dot", async () => {
    for (const url of [
      `https://TestCamp.${APP_HOST_SUFFIX}./sign-in`,
      `https://testcamp.${APP_HOST_SUFFIX}:443/sign-in`,
    ]) {
      const res = await fetchUrl(url);
      expect(res.status, url).toBe(200);
      await res.text();
    }
  });

  it("answers every other host with the same friendly 404", async () => {
    const bodies = new Set<string>();
    for (const url of [
      `https://nosuch.${APP_HOST_SUFFIX}/`,
      "https://evil.example/",
      `https://x.testcamp.${APP_HOST_SUFFIX}/`,
      `https://${APP_HOST_SUFFIX}/`,
      `https://ops.${APP_HOST_SUFFIX}/`,
    ]) {
      const res = await fetchUrl(url);
      expect(res.status, url).toBe(404);
      expect(res.headers.get("Content-Type"), url).toContain("text/html");
      bodies.add(await res.text());
    }
    // Issue #97: a page that says to check the camp's name. One body for every host, which never
    // names the camp that was typed, so nothing tells a real camp from a made-up one.
    expect(bodies.size).toBe(1);
    const [page] = bodies;
    expect(page).toContain("We couldn't find that camp");
    expect(page).toContain(`.${APP_HOST_SUFFIX}`);
    expect(page).not.toContain("nosuch");
  });

  it("answers a camp's mistyped page with a friendly 404", async () => {
    const res = await fetchUrl(`${APP_URL}/no/such/page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("We couldn&#x27;t find that page");
    expect(html).toContain("Check the address for a typo");
  });

  it("treats a camp pending deletion as not existing", async () => {
    await t.db.update(camp).set({ status: "pending_deletion" }).where(eq(camp.id, campB));
    const res = await fetchUrl(`${HOST_B}/sign-in`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("We couldn't find that camp");
    await t.db.update(camp).set({ status: "active" }).where(eq(camp.id, campB));
  });
});

describe("origin checks on writes", () => {
  const form = (origin?: string) =>
    ({
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin ? { origin } : {}),
      },
      body: "email=someone%40example.com",
    }) satisfies RequestInit;

  it("refuses a write with no Origin", async () => {
    const res = await fetchUrl(`${APP_URL}/sign-in`, form());
    expect(res.status).toBe(403);
    await res.text();
  });

  it("refuses another camp's origin on a page action, a resource route and /api/auth", async () => {
    for (const path of ["/sign-in", "/sign-out", "/api/auth/sign-in/magic-link"]) {
      const res = await fetchUrl(`${APP_URL}${path}`, form(HOST_B));
      expect(res.status, path).toBe(403);
      await res.text();
    }
  });

  it("accepts the camp's own origin", async () => {
    const res = await fetchUrl(`${APP_URL}/sign-in`, form(APP_URL));
    expect(res.status).toBe(302);
    await res.text();
  });
});

describe("each request acts for its own camp", () => {
  it("records a sign-in email sent after the response against the right camp", async () => {
    const email = "bea@example.com";
    const [p] = await t.db
      .insert(person)
      .values({ campId: campB, legalName: "Bea Bravo", email })
      .returning();
    await t.db.insert(invite).values({ campId: campB, personId: p.id, email, status: "pending" });

    const before = w.emails.length;
    const res = await fetchUrl(`${HOST_B}/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST_B },
      body: new URLSearchParams({ email }).toString(),
    });
    expect(res.status).toBe(302);
    await res.text();
    for (let i = 0; i < 100 && !w.emails.slice(before).some((m) => m.to === email); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const mail = w.emails.slice(before).find((m) => m.to === email);
    // The link points at camp B's own address.
    expect(mail?.text).toContain(`${HOST_B}/sign-in/confirm?token=`);
    // The Worker hands the email to the provider first and records it in send_log just after,
    // so the email can arrive before its row does: wait for the row.
    let rows: Array<typeof sendLog.$inferSelect> = [];
    for (let i = 0; i < 100 && rows.length === 0; i++) {
      rows = await t.db.select().from(sendLog).where(eq(sendLog.recipient, email));
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.map((r) => r.campId)).toEqual([campB]);
  });

  it("is invited to one camp only: the same email gets nothing at the other camp", async () => {
    const before = w.emails.length;
    const res = await fetchUrl(`${APP_URL}/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_URL },
      body: new URLSearchParams({ email: "bea@example.com" }).toString(),
    });
    expect(res.status).toBe(302);
    await res.text();
    await new Promise((r) => setTimeout(r, 300));
    expect(w.emails.slice(before).filter((m) => m.to === "bea@example.com")).toEqual([]);
  });
});

describe("suspended and demo camps", () => {
  it("a suspended camp can still sign in, but other writes are refused", async () => {
    await t.db.update(camp).set({ status: "suspended" }).where(eq(camp.id, campB));
    try {
      const signIn = await fetchUrl(`${HOST_B}/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST_B },
        body: new URLSearchParams({ email: "bea@example.com" }).toString(),
      });
      expect(signIn.status).toBe(302);
      await signIn.text();

      const rsvp = await fetchUrl(`${HOST_B}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST_B },
        body: "intent=going",
      });
      expect(rsvp.status).toBe(403);
      expect(await rsvp.text()).toMatch(/suspended/);

      // Client-side form posts go to "<path>.data": the same allowance, the same refusal.
      for (const [path, allowed] of [
        ["/sign-in.data", true],
        ["/rsvp.data", false],
      ] as const) {
        const res = await fetchUrl(`${HOST_B}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST_B },
          body: new URLSearchParams({ email: "bea@example.com", intent: "going" }).toString(),
        });
        await res.text();
        expect(res.status !== 403, path).toBe(allowed);
      }
    } finally {
      await t.db.update(camp).set({ status: "active" }).where(eq(camp.id, campB));
    }
  });

  it("the demo camp refuses every write with a friendly message, sign-in included", async () => {
    await t.db.update(camp).set({ kind: "demo" }).where(eq(camp.id, campB));
    try {
      for (const path of ["/sign-in", "/rsvp"]) {
        const res = await fetchUrl(`${HOST_B}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST_B },
          body: "email=x%40example.com",
        });
        expect(res.status, path).toBe(403);
        expect(await res.text()).toMatch(/demo/);
      }
      // It has no sign-in at all: anyone looks around it (R67).
      const page = await fetchUrl(`${HOST_B}/sign-in`);
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe("/demo/enter");
      await page.text();
    } finally {
      await t.db.update(camp).set({ kind: "camp" }).where(eq(camp.id, campB));
    }
  });

  it("the database refuses a suspended camp's writes, except sign-in's", async () => {
    const { context, cf, finish } = makeContext(t.runtimeUrl);
    cf.camp = { ...cf.camp, status: "suspended" };
    await expect(getDb(context).insert(person).values({ legalName: "Nope" })).rejects.toSatisfy(
      readOnlyRefusal,
    );
    await getWriteDb(context).insert(person).values({ legalName: "Allowed" });
    await finish();
  });

  it("the database refuses every write for a demo camp", async () => {
    const { context, cf, finish } = makeContext(t.runtimeUrl);
    cf.camp = { ...cf.camp, kind: "demo" };
    for (const db of [getDb(context), getWriteDb(context)]) {
      await expect(db.insert(person).values({ legalName: "Nope" })).rejects.toSatisfy(
        readOnlyRefusal,
      );
    }
    await finish();
  });
});

describe("the database role requests run as", () => {
  it("is app_runtime: not a superuser, not a table owner, can't bypass row-level security", async () => {
    const { context, finish } = makeContext(t.runtimeUrl);
    const [r] = await getDb(context).execute<{
      user: string;
      super: boolean;
      bypass: boolean;
      owns: number;
    }>(sql`
      select current_user as user, rolsuper as super, rolbypassrls as bypass,
        (select count(*)::int from pg_class where relowner = r.oid) as owns
      from pg_roles r where rolname = current_user`);
    expect(r).toEqual({ user: "app_runtime", super: false, bypass: false, owns: 0 });
    await finish();
  });

  it("only ever sees its own camp's rows, even through raw SQL", async () => {
    await t.db.insert(person).values({ legalName: "Ada Testcamp" });
    const { context, finish } = makeContext(t.runtimeUrl);
    const rows = await getDb(context).execute<{ camp_id: string }>(
      sql`select distinct camp_id from person`,
    );
    expect(rows.map((r) => r.camp_id)).toEqual([t.campId]);
    await finish();
  });
});
