// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDemoCamp } from "../../scripts/lib/demo-data";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, post, startWorker, type TestWorker } from "../helpers/worker";

// R67, U20: a demo visitor picks the role to see the demo camp as (member, Lead or Admin), can
// switch from the banner, and every role is read-only.

const DEMO = `https://demo.${APP_HOST_SUFFIX}`;

let t: TestDb;
// Like the seed script itself: a plain client (the tests' own one is drizzle's, which encodes
// JSON differently and once hid a double-encoding bug).
let plain: ReturnType<typeof postgres>;
let w: TestWorker;

beforeAll(async () => {
  t = await createTestDb();
  plain = postgres(t.url, { max: 1, onnotice: () => {} });
  await resetDemoCamp(plain, { now: new Date("2026-10-01T12:00:00Z") });
  w = await startWorker(t);
});
afterAll(async () => {
  await plain.end();
  await w.dispose();
  await t.drop();
});

const page = async (path: string, cookie: string) => {
  const res = await w.fetch(get(path, cookie, DEMO));
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
};
const enter = async (role: string) => {
  const res = await w.fetch(get(`/demo/enter?as=${role}`, "", DEMO));
  await res.text();
  return { status: res.status, cookie: res.headers.getSetCookie().join("; ").split(";")[0] };
};

describe("choosing a demo role", () => {
  it("offers Member, Lead and Admin", async () => {
    const { status, html } = await page("/demo/enter", "");
    expect(status).toBe(200);
    for (const r of ["member", "lead", "admin"]) expect(html).toContain(`/demo/enter?as=${r}`);
    expect(html).toContain("View as a Member");
    expect(html).toContain("View as an Admin");
  });

  it("shows each role its own navigation, and says which role in the banner", async () => {
    const member = (await enter("member")).cookie;
    expect(member).toBe("__Secure-demo=member");
    const m = await page("/", member);
    expect(m.html).toContain("Welcome, Lantern");
    expect(m.html).toContain("seen as a Member");
    expect(m.html).toContain('href="/demo/enter?as=lead"');
    expect(m.html).not.toContain('href="/roster"');
    expect((await page("/roster", member)).status).toBe(403);

    const lead = (await enter("lead")).cookie;
    const l = await page("/", lead);
    expect(l.html).toContain("Welcome, Compass");
    expect(l.html).toContain('href="/roster"');
    expect(l.html).not.toContain('href="/admin"');

    const admin = (await enter("admin")).cookie;
    const a = await page("/", admin);
    expect(a.html).toContain("Welcome, Sprocket");
    expect(a.html).toContain("seen as an Admin");
    expect(a.html).toContain('href="/admin"');
    expect(a.html).toContain('href="/dues"');
    expect((await page("/admin", admin)).status).toBe(200);
  });

  it("keeps every role read-only", async () => {
    for (const role of ["member", "lead", "admin"]) {
      const cookie = (await enter(role)).cookie;
      const res = await w.fetch(
        post("/profile", { intent: "save", legalName: "Changed" }, { cookie, base: DEMO }),
      );
      expect(res.status, role).toBe(403);
      expect(await res.text(), role).toContain("Saving is off in the demo");
    }
    const count =
      await t.client`select count(*)::int as n from person where legal_name = 'Changed'`;
    expect(count[0].n).toBe(0);
  });

  it("ignores a role it doesn't know", async () => {
    const res = await enter("operator");
    expect(res.status).toBe(200);
    expect(res.cookie).toBe("");
    const forged = await page("/", "__Secure-demo=operator");
    expect(forged.status).toBe(302);
    expect(forged.location).toBe("/demo/enter");
  });
});
