// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verification } from "~/db/auth-schema";
import { authEvent, memberRole } from "~/db/schema";
import { peekMagicToken } from "~/lib/auth-log.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let adminCookie: string;
let leadCookie: string;

async function events(email: string, until?: string) {
  for (let i = 0; i < 50; i++) {
    const rows = await t.db
      .select()
      .from(authEvent)
      .where(eq(authEvent.email, email))
      .orderBy(asc(authEvent.createdAt));
    if (!until || rows.some((r) => r.event === until)) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${until} event for ${email}`);
}

async function linkFor(email: string) {
  const before = w.emails.length;
  await w.fetch(post("/sign-in", { email }));
  for (let i = 0; i < 50; i++) {
    const mail = w.emails.slice(before).find((e) => e.to === email);
    if (mail) {
      const line = mail.text.split("\n").find((l) => l.includes("/sign-in/confirm")) ?? "";
      return new URL(line).searchParams.get("token") ?? "";
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no email");
}

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const admin = await invitePerson(t, "admin@example.com", { playaName: "Boss" });
  await t.db.insert(memberRole).values({ personId: admin.id, role: "admin" });
  adminCookie = await signIn(w, "admin@example.com");
  const lead = await invitePerson(t, "lead@example.com", { playaName: "Captain" });
  await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
  leadCookie = await signIn(w, "lead@example.com");
  await w.fetch(get("/", adminCookie));
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("sign-in log", () => {
  it("records each step of a first sign-in, with no token anywhere", async () => {
    await invitePerson(t, "new@example.com", { playaName: "Newbie" });
    const cookie = await signIn(w, "new@example.com");
    await w.fetch(get("/", cookie));
    const rows = await events("new@example.com", "account_linked");
    expect(rows.map((r) => r.event)).toEqual([
      "link_requested",
      "link_sent",
      "signed_in",
      "account_linked",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/token=|sign-in\/confirm/);
  });

  it("records an uninvited email, and lists it as stuck for Admins", async () => {
    await w.fetch(post("/sign-in", { email: "stranger@example.com" }));
    expect((await events("stranger@example.com", "link_not_sent")).map((r) => r.event)).toEqual([
      "link_requested",
      "link_not_sent",
    ]);
    const html = await (await w.fetch(get("/admin/logs", adminCookie))).text();
    expect(html).toContain("Asked for a link but haven");
    expect(html).toContain("stranger@example.com");
    expect(html).toContain("Not in the app");
  });

  it("records an expired link and why it failed", async () => {
    await invitePerson(t, "late@example.com", { playaName: "Latecomer" });
    const token = await linkFor("late@example.com");
    await t.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) });
    const opened = await w.fetch(get(`/sign-in/confirm?token=${token}`));
    expect(opened.status).toBe(200);
    const res = await w.fetch(post("/sign-in/confirm", { token }));
    expect(res.headers.get("Location")).toMatch(/\/sign-in\/error/);
    const rows = await events("late@example.com", "sign_in_failed");
    expect(rows.find((r) => r.event === "link_opened")?.detail).toMatchObject({ link: "expired" });
    expect(rows.find((r) => r.event === "sign_in_failed")?.detail).toMatchObject({
      link: "expired",
    });
  });

  it("sends someone who is already signed in straight home from a link", async () => {
    const token = await linkFor("lead@example.com");
    const res = await w.fetch(get(`/sign-in/confirm?token=${token}`, leadCookie));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("shows the confirm page as Continue signing in, not a second Sign in", async () => {
    await invitePerson(t, "page@example.com");
    const token = await linkFor("page@example.com");
    const html = await (await w.fetch(get(`/sign-in/confirm?token=${token}`))).text();
    expect(html).toContain("Continue signing in");
    expect(html).not.toContain("Sign in to Test Camp");
  });

  it("is Admin-only, and filters by name or email", async () => {
    expect((await w.fetch(get("/admin/logs", leadCookie))).status).toBe(403);
    const html = await (await w.fetch(get("/admin/logs?q=Newbie", adminCookie))).text();
    expect(html).toContain("new@example.com");
    expect(html).not.toContain("stranger@example.com");
  });
});

// Better Auth 1.7.7 stores a hashed token as "magic-link:<hash>"; before, the bare hash. Links
// emailed just before an upgrade are stored the old way, so both are read.
describe("peeking at a link without using it", () => {
  async function store(token: string, identifierFor: (hash: string) => string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = Buffer.from(digest).toString("base64url");
    await t.db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: identifierFor(hash),
      value: JSON.stringify({ type: "magic-link", email: `${token}@example.com` }),
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  it("reads a token stored either way", async () => {
    await store("prefixed", (h) => `magic-link:${h}`);
    await store("bare", (h) => h);
    expect(await peekMagicToken(t.db, "prefixed")).toEqual({
      email: "prefixed@example.com",
      state: "valid",
    });
    expect(await peekMagicToken(t.db, "bare")).toEqual({
      email: "bare@example.com",
      state: "valid",
    });
    expect(await peekMagicToken(t.db, "unknown")).toEqual({
      email: null,
      state: "used_or_unknown",
    });
  });
});
