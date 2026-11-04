// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session, user } from "~/db/auth-schema";
import { auditLog, authEvent, burn, camp, campSettings, person } from "~/db/schema";
import { APP_HOST_SUFFIX, APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  get,
  invitePerson,
  post,
  requestLinkToken,
  signIn,
  startWorker,
  type TestWorker,
} from "../helpers/worker";

// Sign-in across two camps through the real Worker: camp A is the default test camp, camp B
// ("bravo") is added here. One login may belong to both, but nothing carries between them.
let t: TestDb;
let w: TestWorker;
let campB: string;
const B = `https://bravo.${APP_HOST_SUFFIX}`;

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

const isSignInRedirect = (res: Response) =>
  res.status === 302 && (res.headers.get("Location") ?? "").endsWith("/sign-in");

describe("one login, a separate person and session per camp", () => {
  const email = "sam@example.com";
  let cookieA = "";
  let cookieB = "";

  beforeAll(async () => {
    await invitePerson(t, email, { legalName: "Sam at Alpha" });
    await invitePerson(t, email, { legalName: "Sam at Bravo", campId: campB });
    cookieA = await signIn(w, email);
    cookieB = await signIn(w, email, B);
  });

  it("signs in at each camp to that camp's own person", async () => {
    const homeA = await w.fetch(get("/profile", cookieA));
    expect(homeA.status).toBe(200);
    const pageA = await homeA.text();
    expect(pageA).toContain("Sam at Alpha");
    expect(pageA).not.toContain("Sam at Bravo");

    const homeB = await w.fetch(get("/profile", cookieB, B));
    const pageB = await homeB.text();
    expect(pageB).toContain("Sam at Bravo");
    expect(pageB).not.toContain("Sam at Alpha");

    // One login, two people.
    const people = await t.db.select().from(person).where(eq(person.email, email));
    expect(new Set(people.map((p) => p.authUserId)).size).toBe(1);
    expect(people.map((p) => p.campId).sort()).toEqual([t.campId, campB].sort());
  });

  it("records each session against its own camp", async () => {
    const [login] = await t.db.select().from(user).where(eq(user.email, email));
    const rows = await t.db.select().from(session).where(eq(session.userId, login.id));
    expect(rows.map((r) => r.campId).sort()).toEqual([t.campId, campB].sort());
  });

  it("doesn't accept camp A's session cookie at camp B", async () => {
    const res = await w.fetch(get("/profile", cookieA, B));
    expect(isSignInRedirect(res)).toBe(true);
    await res.text();
  });

  it("keeps the sign-in log for each camp in that camp", async () => {
    const events = await t.db
      .select({ campId: authEvent.campId })
      .from(authEvent)
      .where(and(eq(authEvent.email, email), eq(authEvent.event, "signed_in")));
    expect(events.map((e) => e.campId).sort()).toEqual([t.campId, campB].sort());
  });
});

describe("magic-link tokens", () => {
  it("refuses a token issued at camp A when it's submitted at camp B", async () => {
    const email = "tess@example.com";
    await invitePerson(t, email);
    await invitePerson(t, email, { campId: campB });
    const token = await requestLinkToken(w, email); // issued at camp A
    expect(token.startsWith(`${t.campId}.`)).toBe(true);

    const res = await w.fetch(post("/sign-in/confirm", { token }, { base: B }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in/error");
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
    await res.text();

    // It still works where it was issued.
    const ok = await w.fetch(post("/sign-in/confirm", { token }));
    expect(ok.headers.getSetCookie().join(";")).toContain("session_token");
    await ok.text();
  });
});

describe("Better Auth's HTTP endpoints", () => {
  it("opens only get-session and sign-out", async () => {
    for (const path of [
      "/api/auth/list-sessions",
      "/api/auth/magic-link/verify?token=x",
      "/api/auth/list-accounts",
      "/api/auth/update-user",
    ]) {
      const res = await w.fetch(new Request(`${APP_URL}${path}`));
      expect(res.status, path).toBe(404);
      await res.text();
    }
    const res = await w.fetch(new Request(`${APP_URL}/api/auth/get-session`));
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("changing the sign-in email", () => {
  it("changes the login, and the person's email in every camp, without naming the others", async () => {
    const email = "remy@example.com";
    const newEmail = "remy.new@example.com";
    await invitePerson(t, email, { legalName: "Remy A" });
    const [pB] = await invitePerson(t, email, { legalName: "Remy B", campId: campB }).then((p) => [
      p,
    ]);
    const cookieA = await signIn(w, email);
    // Their first page at camp B links the login to camp B's person.
    const cookieB = await signIn(w, email, B);
    await (await w.fetch(get("/", cookieB, B))).text();

    const before = w.emails.length;
    const req = await w.fetch(
      post("/profile", { intent: "email_change", newEmail }, { cookie: cookieA }),
    );
    expect(req.status).toBe(302);
    await req.text();
    // The current address approves first; then the new one confirms.
    const tokenIn = (to: string, path: string) => {
      const mail = w.emails.slice(before).find((m) => m.to === to && m.text.includes(path));
      const line = mail?.text.split("\n").find((l) => l.includes(path)) ?? "";
      return new URL(line).searchParams.get("token") ?? "";
    };
    const approved = await w.fetch(
      post("/email/approve", { token: tokenIn(email, "/email/approve") }),
    );
    expect(approved.status).toBe(200);
    await approved.text();
    const token = tokenIn(newEmail, "/email/confirm");

    const done = await w.fetch(post("/email/confirm", { token }));
    expect(done.status).toBe(200);
    await done.text();

    const [login] = await t.db.select().from(user).where(eq(user.email, newEmail));
    expect(login).toBeTruthy();
    const [bNow] = await t.db.select().from(person).where(eq(person.id, pB.id));
    expect(bNow.email).toBe(newEmail);
    const logB = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, pB.id), eq(auditLog.action, "email_changed")));
    expect(logB.map((r) => r.campId)).toEqual([campB]);

    // Signed out at camp B too.
    const outB = await w.fetch(get("/profile", cookieB, B));
    expect(outB.status).toBe(302);
    await outB.text();

    // The notice to the old address doesn't name camp B.
    const notice = w.emails
      .slice(before)
      .find((m) => m.to === email && m.text.includes("was just changed"));
    expect(notice).toBeTruthy();
    expect(notice?.text ?? "").not.toMatch(/bravo/i);

    // And the new address signs in at camp B.
    const cookieB2 = await signIn(w, newEmail, B);
    const res = await w.fetch(get("/profile", cookieB2, B));
    expect(await res.text()).toContain("Remy B");
  });

  it("refuses an address another camp's active person already has", async () => {
    await t.db
      .insert(person)
      .values({ campId: campB, legalName: "Owner", email: "taken@example.com" });
    const email = "uma@example.com";
    await invitePerson(t, email);
    const cookie = await signIn(w, email);
    const res = await w.fetch(
      post("/profile", { intent: "email_change", newEmail: "taken@example.com" }, { cookie }),
    );
    expect(await res.text()).toMatch(/address can.*t be used/);
  });
});
