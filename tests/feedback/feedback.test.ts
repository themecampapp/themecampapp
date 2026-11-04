// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memberRole } from "~/db/schema";
import { feedbackPath } from "~/lib/feedback";
import {
  expireFeedback,
  listFeedback,
  notifyFeedback,
} from "../../platform/app/lib/feedback.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { fakeSend, TEST_EMAIL_ENV } from "../helpers/mail";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// R65: in-app feedback to the operator. Stored with the camp, the page (ids removed), the role
// and the time, never who sent it; camps can add to it but never read it.

const env = {
  PLATFORM_DOMAIN: "themecamp.test",
  ALERT_MAIL_FROM: "notify@mail.themecamp.test",
  ...TEST_EMAIL_ENV,
  OPERATOR_EMAIL: "operator@example.com",
} as PlatformEnv;

let t: TestDb;
let z: Zulu;
let w: TestWorker;
let member: string;
let lead: string;
let platform: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  await invitePerson(t, "mo@example.com", { legalName: "Mo Member" });
  member = await signIn(w, "mo@example.com");
  const l = await invitePerson(t, "lee@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
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
  await t.client`truncate feedback`;
});

const send = (message: string, from: string, cookie = member) =>
  w.fetch(post("/feedback", { from, message }, { cookie }));

describe("sending feedback", () => {
  it("stores the camp, the page without ids, the role and the words, and confirms by email", async () => {
    const before = w.emails.length;
    const res = await send("The roster is great", `/people/${z.memberId}?q=sam#x`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/feedback?sent=1&from=%2Fpeople%2F%3Aid");
    await res.text();
    await (await send("Leads need a calendar", "/roster/123", lead)).text();

    const rows = await t.client`
      select c.slug, f.path, f.role, f.message from feedback f join camp c on c.id = f.source_camp_id
      order by f.created_at`;
    expect(rows).toEqual([
      { slug: "testcamp", path: "/people/:id", role: "member", message: "The roster is great" },
      { slug: "testcamp", path: "/roster/:id", role: "lead", message: "Leads need a calendar" },
    ]);
    const mail = w.emails.slice(before).find((e) => e.to === "mo@example.com");
    expect(mail?.subject).toBe("Thanks for your feedback on Theme Camp App");
    expect(mail?.text).not.toContain("roster is great");
  });

  it("links from every signed-in page, with that page", async () => {
    const html = await (await w.fetch(get("/profile", member))).text();
    expect(html).toContain('href="/feedback?from=%2Fprofile"');
    // An id in the link is taken out of the address before the page shows.
    const res = await w.fetch(get(`/feedback?from=/people/${z.memberId}`, member));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/feedback?from=%2Fpeople%2F%3Aid");
    await res.text();
    const page = await (await w.fetch(get("/feedback?from=%2Fpeople%2F%3Aid", member))).text();
    expect(page).toContain("your camp&#x27;s Leads don&#x27;t see it");
    expect(page).toContain("Please don&#x27;t include other people&#x27;s personal details.");
  });

  it("refuses an empty message, and more than 30 an hour from one camp", async () => {
    const empty = await send("   ", "/");
    expect(empty.status).not.toBe(302);
    expect(await empty.text()).toContain("Write something to send.");
    await t.client`
      insert into feedback (source_camp_id, path, role, message)
      select ${t.campId}, '/', 'member', 'x' from generate_series(1, 30)`;
    const busy = await send("One more", "/");
    expect(busy.status).not.toBe(302);
    expect(await busy.text()).toContain("A lot of feedback has come from this camp");
  });
});

describe("keeping feedback from camps", () => {
  it("lets the camp's database role add feedback only for its own camp, and never read it", async () => {
    await t.client`
      insert into feedback (source_camp_id, path, role, message)
      values (${z.campId}, '/', 'admin', 'Zulu secret')`;
    for (const q of [
      "select * from feedback",
      "update feedback set message = 'x'",
      "delete from feedback",
      "insert into feedback (source_camp_id, path, role, message) values (gen_random_uuid(), '/', 'member', 'x')",
    ]) {
      await expect(runtime.unsafe(q), q).rejects.toThrow(/permission denied/);
    }
    // Through the function, with a camp set, it lands in that camp, whatever the caller wants.
    await runtime.begin(async (tx) => {
      await tx`select set_config('app.camp_id', ${t.campId}, true)`;
      await tx`select submit_feedback('/', 'member', 'via function')`;
    });
    const [row] =
      await t.client`select source_camp_id from feedback where message = 'via function'`;
    expect(row.source_camp_id).toBe(t.campId);
    await expect(runtime`select submit_feedback('/', 'member', 'no camp')`).rejects.toThrow(
      /no camp is set/,
    );
  });
});

describe("the operator's side", () => {
  let sent: Array<{ to: string; subject: string; body: string }>;
  let providerUp: boolean;
  beforeEach(() => {
    sent = [];
    providerUp = true;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      providerUp ? fakeSend((m) => sent.push(m))(url, init) : new Response("down", { status: 503 }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists feedback with the camp's slug, newest first", async () => {
    await t.client`
      insert into feedback (source_camp_id, path, role, message, created_at) values
        (${t.campId}, '/a', 'member', 'older', now() - interval '1 day'),
        (${z.campId}, '/b', 'lead', 'newer', now())`;
    const list = await listFeedback(platform);
    expect(list.map((f) => [f.slug, f.path, f.role, f.message])).toEqual([
      ["zulu", "/b", "lead", "newer"],
      ["testcamp", "/a", "member", "older"],
    ]);
  });

  it("emails the operator a link only, once, and retries if the email didn't go", async () => {
    await t.client`
      insert into feedback (source_camp_id, path, role, message)
      values (${t.campId}, '/', 'member', 'private words'), (${t.campId}, '/', 'member', 'more')`;
    providerUp = false;
    expect(await notifyFeedback(platform, env)).toBe(0);
    providerUp = true;
    expect(await notifyFeedback(platform, env)).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("operator@example.com");
    expect(sent[0].subject).toBe("2 new feedback messages");
    expect(sent[0].body).toContain("https://ops.themecamp.test/ops/feedback");
    expect(sent[0].body).not.toContain("private words");
    expect(await notifyFeedback(platform, env)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("removes feedback after 12 months", async () => {
    await t.client`
      insert into feedback (source_camp_id, path, role, message, created_at) values
        (${t.campId}, '/', 'member', 'old', now() - interval '13 months'),
        (${t.campId}, '/', 'member', 'recent', now() - interval '11 months')`;
    expect(await expireFeedback(platform)).toBe(1);
    const rows = await t.client`select message from feedback`;
    expect(rows.map((r) => r.message)).toEqual(["recent"]);
  });
});

describe("feedbackPath", () => {
  it("keeps only the path, with ids taken out", () => {
    expect(feedbackPath("/people/0b9c3f7e-1d2a-4c3b-8a9b-1234567890ab/edit?x=1#y")).toBe(
      "/people/:id/edit",
    );
    expect(feedbackPath("/roster/42")).toBe("/roster/:id");
    expect(feedbackPath("/yearbook/sam%40example.com")).toBe("/yearbook/:id");
    expect(feedbackPath("/guides/packing-list")).toBe("/guides/packing-list");
    expect(feedbackPath("/roster.data")).toBe("/roster");
    expect(feedbackPath("https://evil.example/x")).toBe("/");
    expect(feedbackPath("//evil.example")).toBe("/");
    expect(feedbackPath(null)).toBe("/");
  });
});
