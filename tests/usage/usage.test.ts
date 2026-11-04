// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memberRole } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// R74: usage counted per camp per day, as route ids and fixed names only, and read across
// camps only through camp_usage().

let t: TestDb;
let z: Zulu;
let w: TestWorker;
let lead: string;
let leadId: string;
let samId: string;
let platform: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;

const showUntil = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  const l = await invitePerson(t, "lee@example.com", { legalName: "Lee Lead" });
  leadId = l.id;
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  samId = (await invitePerson(t, "sam@example.com", { legalName: "Samwise Membername" })).id;
  lead = await signIn(w, "lee@example.com");
  const url = new URL(t.runtimeUrl);
  runtime = postgres(url.toString(), { max: 1, onnotice: () => {} });
  url.username = "app_platform";
  platform = postgres(url.toString(), { max: 1, fetch_types: false, onnotice: () => {} });
});
afterAll(async () => {
  await runtime.end();
  await platform.end();
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate usage_daily`;
});

// Counting happens after the response; give it a moment.
async function counts(campId = t.campId) {
  await new Promise((r) => setTimeout(r, 400));
  const rows = await t.client<{ metric: string; count: number }[]>`
    select metric, count from usage_daily where camp_id = ${campId} order by metric`;
  return Object.fromEntries(rows.map((r) => [r.metric, r.count]));
}
const fetchText = async (req: Request) => {
  const res = await w.fetch(req);
  await res.text();
  return res;
};

describe("counting in the camp Worker", () => {
  it("counts a page view under its route id, never the URL, for this camp only", async () => {
    await fetchText(get(`/people/${samId}`, lead));
    await fetchText(get(`/people/${samId}.data`, lead));
    await fetchText(get("/", lead));
    const c = await counts();
    expect(c["view:routes/_app.lead.people.$id"]).toBe(2);
    expect(c["view:routes/_app._index"]).toBe(1);
    expect(Object.keys(c).join(" ")).not.toMatch(UUID);
    expect(await counts(z.campId)).toEqual({});
  });

  it("marks the member as active today", async () => {
    await t.client`update person set last_seen_on = null where id = ${leadId}`;
    await fetchText(get("/", lead));
    await new Promise((r) => setTimeout(r, 400));
    const [p] = await t.client`select last_seen_on::text as d from person where id = ${leadId}`;
    expect(p.d).toBe(new Date().toISOString().slice(0, 10));
  });

  it("counts error responses by status and route", async () => {
    await fetchText(get("/roster/not-an-id", lead));
    await fetchText(get("/no/such/page", lead));
    // A loader that fails: its table is briefly missing.
    await t.client`alter table announcement rename to announcement_away`;
    try {
      const res = await fetchText(get("/announcements", lead));
      expect(res.status).toBe(500);
    } finally {
      await t.client`alter table announcement_away rename to announcement`;
    }
    const c = await counts();
    expect(c["status:404:routes/_app.lead.roster.$personId"]).toBe(1);
    expect(c["status:500:routes/_app.lead.announcements"]).toBe(1);
    expect(Object.keys(c).some((m) => m.startsWith("status:404:"))).toBe(true);
    expect(c["view:routes/_app.lead.announcements"]).toBeUndefined();
  });

  it("keeps only a browser error's type and a known route id", async () => {
    const beacon = (fields: Record<string, string>) =>
      fetchText(post("/__usage/client-error", fields, { cookie: lead }));
    const res = await beacon({
      type: "TypeError",
      route: "routes/_app.lead.roster",
      message: "Cannot read Samwise Membername",
      stack: "at sam@example.com",
    });
    expect(res.status).toBe(204);
    await beacon({ type: "<script>", route: "routes/_app.lead.roster" });
    await beacon({ type: "TypeError", route: "routes/sam@example.com" });
    const c = await counts();
    expect(c).toEqual({
      "client_error:Other:routes/_app.lead.roster": 1,
      "client_error:TypeError:routes/_app.lead.roster": 1,
    });
  });

  it("still serves the page when a count can't be written", async () => {
    await t.client`alter table usage_daily add constraint usage_off check (false) not valid`;
    try {
      const res = await w.fetch(get("/", lead));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Lee");
      expect(await counts()).toEqual({});
    } finally {
      await t.client`alter table usage_daily drop constraint usage_off`;
    }
  });
});

describe("camp_usage()", () => {
  it("adds features used, sign-ins and email from the existing logs, per camp", async () => {
    await fetchText(
      post(
        "/announcements",
        { intent: "post", title: "Build day", body: "", showUntil },
        { cookie: lead },
      ),
    );
    await fetchText(get("/", lead));
    await new Promise((r) => setTimeout(r, 400));
    const rows = await platform<{ camp_id: string; metric: string; count: number }[]>`
      select * from camp_usage(current_date - 6)`;
    const ours = rows.filter((r) => r.camp_id === t.campId).map((r) => r.metric);
    expect(ours).toContain("action:announcement_posted");
    expect(ours).toContain("auth:signed_in");
    expect(ours).toContain("auth:link_requested");
    expect(ours).toContain("view:routes/_app._index");
    expect(ours).toContain("active:7d");
    const zulu = rows.filter((r) => r.camp_id === z.campId).map((r) => r.metric);
    expect(zulu).not.toContain("action:announcement_posted");
    // Only the four columns, and nothing that looks like an id or an address.
    expect(Object.keys(rows[0]).sort()).toEqual(["camp_id", "count", "day", "metric"]);
    for (const r of rows) {
      expect(r.metric).not.toMatch(UUID);
      expect(r.metric).not.toContain("@");
    }
  });

  it("is for the platform only", async () => {
    await expect(runtime`select * from camp_usage(current_date)`).rejects.toThrow(
      /permission denied/,
    );
  });
});
