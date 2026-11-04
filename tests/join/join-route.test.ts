// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inquiry, memberRole } from "~/db/schema";
import { APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});
beforeEach(() => {
  Object.assign(w.turnstile, {
    success: true,
    hostname: new URL(APP_URL).hostname,
    action: "join",
  });
});

const submit = (fields: Record<string, string>, ip: string) => {
  const req = post("/join", { "cf-turnstile-response": "token", ...fields });
  req.headers.set("cf-connecting-ip", ip);
  return w.fetch(req);
};

describe("public join page through the real Worker", () => {
  it("renders for anyone, with the Turnstile widget", async () => {
    const res = await w.fetch(get("/join"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-sitekey="site-key-test"');
    expect(html).toContain('data-action="join"');
  });

  it("records a verified submission and redirects to the thank-you page", async () => {
    const res = await submit({ name: "Real Person", email: "real@example.com" }, "198.51.100.1");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/join/thanks");
    const rows = await t.db.select().from(inquiry);
    expect(rows.map((r) => r.email)).toContain("real@example.com");
    expect(w.emails.map((e) => e.to)).toEqual(
      expect.arrayContaining(["real@example.com", "leads@example.com"]),
    );
  });

  it.each([
    ["a failed check", { success: false }],
    ["a token for another hostname", { hostname: "evil.example" }],
    ["a token for another form", { action: "login" }],
  ])("rejects %s and stores nothing", async (_label, verdict) => {
    Object.assign(w.turnstile, verdict);
    const before = (await t.db.select().from(inquiry)).length;
    const res = await submit({ name: "Bot", email: "bot@example.com" }, "198.51.100.2");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("confirm you");
    expect(await t.db.select().from(inquiry)).toHaveLength(before);
  });

  it("gives honeypot-filling bots the normal thank-you page but stores nothing", async () => {
    const before = (await t.db.select().from(inquiry)).length;
    const res = await submit(
      { name: "Bot", email: "honey@example.com", website: "http://spam" },
      "198.51.100.3",
    );
    expect(res.headers.get("Location")).toBe("/join/thanks");
    expect(await t.db.select().from(inquiry)).toHaveLength(before);
  });

  it("throttles a burst from one IP (5 a minute), still showing thanks", async () => {
    // The limiter counts in fixed one-minute windows, so a burst can straddle a boundary:
    // assert that some of 12 were throttled and no more than two windows' worth got in.
    for (let i = 0; i < 12; i++) {
      const res = await submit(
        { name: `Person ${i}`, email: `burst${i}@example.com` },
        "203.0.113.50",
      );
      expect(res.headers.get("Location")).toBe("/join/thanks");
    }
    const stored = (await t.db.select().from(inquiry)).filter((r) => r.email?.startsWith("burst"));
    expect(stored.length).toBeGreaterThanOrEqual(5);
    expect(stored.length).toBeLessThanOrEqual(10);
  });

  it("keeps the inquiry pipeline Lead-only", async () => {
    await invitePerson(t, "member@example.com");
    const cookie = await signIn(w, "member@example.com");
    expect((await w.fetch(get("/inquiries", cookie))).status).toBe(403);

    const lead = await invitePerson(t, "lead@example.com");
    await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
    const leadCookie = await signIn(w, "lead@example.com");
    const html = await (await w.fetch(get("/inquiries", leadCookie))).text();
    expect(html).toContain("real@example.com");
  });
});
