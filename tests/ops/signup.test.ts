// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireSignups } from "../../platform/app/lib/signup.server";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { startPlatform } from "../helpers/platform";

// Issue #73: camps ask to join on the public sign-up page; the operator approves (creating the
// camp and inviting its Admins) or declines each request in the console.

const DISCORD = "https://discord.gg/support-test";

let t: TestDb;
let platform: Awaited<ReturnType<typeof startPlatform>>;

beforeAll(async () => {
  t = await createTestDb();
  platform = await startPlatform(t);
});
afterAll(async () => {
  await platform.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`delete from camp_signup`;
  platform.mail.length = 0;
  platform.discord.length = 0;
  platform.turnstile.success = true;
});

const request = (fields: Record<string, string> = {}, ip?: string) =>
  platform.site(
    "/signup",
    {
      campName: "  Dusty   Owls ",
      slug: "dusty-owls",
      adminName0: "Olive Owl",
      adminEmail0: " Olive@Example.com ",
      adminName1: "Barney Barn",
      adminEmail1: "barney@example.com",
      adminName2: "",
      adminEmail2: "",
      seasonYear: String(
        new Date().getUTCMonth() >= 8
          ? new Date().getUTCFullYear() + 1
          : new Date().getUTCFullYear(),
      ),
      campSize: "25_50",
      note: "We camp at 7:30.",
      "cf-turnstile-response": "token",
      ...fields,
    },
    ip,
  );
const signups = () => t.client`select * from camp_signup order by created_at`;

describe("the sign-up page", () => {
  it("is at signup.<domain>, which sends people to the apex's page", async () => {
    const res = await platform.mf.dispatchFetch(`https://signup.${APP_HOST_SUFFIX}/anything`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://${APP_HOST_SUFFIX}/signup`);
  });

  it("explains the pilot and how camps' data is kept, and asks for what we need", async () => {
    const res = await platform.site("/signup");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("free pilot");
    expect(html).toContain('href="/legal/pilot-agreement"');
    expect(html).toContain("Every camp is walled off from every other");
    expect(html).toContain("never sell or share your campers");
    expect(html).toContain('href="/legal/privacy"');
    for (const name of [
      "campName",
      "slug",
      "adminName0",
      "adminEmail0",
      "seasonYear",
      "campSize",
      "note",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('data-action="signup"');
  });

  it("queues a request, tidied, and tells the operator's Discord without anyone's details", async () => {
    const res = await request();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signup/thanks");
    const [s] = await signups();
    expect(s).toMatchObject({
      camp_name: "Dusty Owls",
      slug: "dusty-owls",
      admins: [
        { name: "Olive Owl", email: "olive@example.com" },
        { name: "Barney Barn", email: "barney@example.com" },
      ],
      camp_size: "25_50",
      note: "We camp at 7:30.",
      status: "pending",
    });
    expect(platform.discord).toHaveLength(1);
    expect(platform.discord[0]).toContain("📥 Sign-up request: **Dusty Owls** (2 organizers)");
    expect(platform.discord[0]).not.toMatch(/example\.com|Olive|Barney/);
    expect(platform.mail).toHaveLength(0);
  });

  it("thanks them, says what happens next, and invites them to Discord", async () => {
    const html = await (await platform.site("/signup/thanks")).text();
    expect(html).toContain(
      "As soon as your request is approved, you&#x27;ll get an email to set up your camp.",
    );
    expect(html).toContain(`href="${DISCORD}"`);
  });

  it("refuses bad requests with a reason, keeping what was typed, and stores nothing", async () => {
    for (const [fields, says] of [
      [{ slug: "testcamp" }, "A camp already has that address"],
      [{ slug: "ops" }, "That address is reserved"],
      [{ slug: "Dusty Owls" }, "lowercase letters"],
      [{ campName: " " }, "Enter your camp"],
      [{ adminEmail0: "not-an-email" }, "check each email"],
      [{ adminEmail1: "OLIVE@example.com" }, "their own email"],
      [{ adminName1: "" }, "each organizer&#x27;s name"],
      [
        { adminName0: "", adminEmail0: "", adminName1: "", adminEmail1: "" },
        "at least one organizer",
      ],
      [{ seasonYear: "1999" }, "season you&#x27;re planning"],
      [{ campSize: "huge" }, "size from the list"],
    ] as Array<[Record<string, string>, string]>) {
      const res = await request(fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      const html = await res.text();
      expect(html, JSON.stringify(fields)).toContain(says);
      expect(html).toContain("We camp at 7:30."); // what they typed is kept
    }
    expect(await signups()).toHaveLength(0);
    expect(platform.discord).toHaveLength(0);
  });

  it("refuses a failed Turnstile check, and posts from other sites", async () => {
    platform.turnstile.success = false;
    const res = await request();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("couldn&#x27;t confirm you&#x27;re a person");
    platform.turnstile.success = true;
    const cross = await platform.mf.dispatchFetch(`https://${APP_HOST_SUFFIX}/signup`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "campName=x",
    });
    expect(cross.status).toBe(403);
    expect(await signups()).toHaveLength(0);
  });

  it("limits how often one address can send requests", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++)
      codes.push((await request({ slug: `camp-${i}` }, "198.51.100.7")).status);
    expect(codes.filter((c) => c === 302).length).toBeLessThanOrEqual(5);
    expect(codes).toContain(400);
  });
});

describe("deciding requests in the console", () => {
  const submit = async (fields: Record<string, string> = {}) => {
    await request(fields);
    const rows = await signups();
    return rows[rows.length - 1].id as string;
  };
  const decide = (id: string, fields: Record<string, string>) =>
    platform.consolePost(`/ops/signups/${id}`, fields);
  const approveFields = (extra: Record<string, string> = {}) => ({
    intent: "approve",
    name: "Dusty Owls",
    slug: "dusty-owls",
    year: String(
      new Date().getUTCMonth() >= 8 ? new Date().getUTCFullYear() + 1 : new Date().getUTCFullYear(),
    ),
    adminName0: "Olive Owl",
    adminEmail0: "olive@example.com",
    adminName1: "Barney Barn",
    adminEmail1: "barney@example.com",
    ...extra,
  });

  it("lists waiting requests, with a count in the console's menu", async () => {
    const id = await submit();
    const list = await (await platform.consoleGet("/ops/signups")).text();
    expect(list).toContain("Sign-ups (1)");
    expect(list).toContain(`href="/ops/signups/${id}"`);
    expect(list).not.toContain("olive@example.com"); // contact details on the request's page only
    const page = await (await platform.consoleGet(`/ops/signups/${id}`)).text();
    expect(page).toContain("olive@example.com");
    expect(page).toContain("We camp at 7:30.");
  });

  it("approves: creates the camp, makes each organizer an Admin and invites them", async () => {
    const id = await submit();
    platform.discord.length = 0;
    const res = await decide(id, approveFields({ name: "Dusty Owls Camp" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/ops\/camps\/[0-9a-f-]+\?notice=/);
    const [c] =
      await t.client`select id, name, created_in_console from camp where slug = 'dusty-owls'`;
    expect(c).toMatchObject({ name: "Dusty Owls Camp", created_in_console: true });
    const people = await t.client`
      select p.email, array_agg(r.role order by r.role) as roles from person p
      join member_role r on r.person_id = p.id where p.camp_id = ${c.id}
      group by p.email order by p.email`;
    expect(people).toEqual([
      { email: "barney@example.com", roles: ["admin", "lead", "treasurer"] },
      { email: "olive@example.com", roles: ["admin", "lead", "treasurer"] },
    ]);
    expect(platform.mail.map((m) => m.to).sort()).toEqual([
      "barney@example.com",
      "olive@example.com",
    ]);
    const olive = platform.mail.find((m) => m.to === "olive@example.com");
    expect(olive?.body).toContain("one of its first Admins, with Barney Barn");
    expect(olive?.body).toContain(DISCORD);
    const [s] = await signups();
    expect(s).toMatchObject({ status: "approved", created_camp_id: c.id });
    expect(s.decided_by_operator_id).not.toBeNull();
    const log =
      await t.client`select action from operator_log where action in ('signup_approved', 'camp_created')`;
    expect(log.map((l) => l.action).sort()).toEqual(["camp_created", "signup_approved"]);
    // One decision per request.
    const again = await decide(id, approveFields({ slug: "dusty-owls-2" }));
    expect(await again.text()).toContain("already been decided");
  });

  it("puts the request back if the camp can't be created", async () => {
    const id = await submit({ slug: "owls-two" });
    const res = await decide(id, approveFields({ slug: "testcamp" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Another camp already has that address");
    const [s] = await signups();
    expect(s).toMatchObject({ status: "pending", decided_at: null, created_camp_id: null });
    expect(platform.mail).toHaveLength(0);
  });

  it("declines, emailing the organizers only when there's a message", async () => {
    const quiet = await submit({ slug: "quiet-owls" });
    expect((await decide(quiet, { intent: "decline", message: "" })).status).toBe(302);
    expect(platform.mail).toHaveLength(0);
    const told = await submit({ slug: "told-owls" });
    await decide(told, { intent: "decline", message: "We're full for this season." });
    expect(platform.mail.map((m) => m.to).sort()).toEqual([
      "barney@example.com",
      "olive@example.com",
    ]);
    expect(platform.mail[0].body).toContain("full for this season");
    const rows = await signups();
    expect(rows.map((r) => r.status)).toEqual(["declined", "declined"]);
  });

  it("removes decided requests after 90 days, never waiting ones", async () => {
    const old = await submit({ slug: "old-owls" });
    await submit({ slug: "new-owls" });
    await t.client`
      update camp_signup set status = 'declined', decided_at = now() - interval '91 days'
      where id = ${old}`;
    const url = new URL(t.runtimeUrl);
    url.username = "app_platform";
    const asPlatform = postgres(url.toString(), { max: 1 });
    try {
      await expireSignups(asPlatform);
    } finally {
      await asPlatform.end();
    }
    expect((await signups()).map((s) => s.slug)).toEqual(["new-owls"]);
  });

  it("is never readable by the camp Worker", async () => {
    const runtime = postgres(t.runtimeUrl, { max: 1 });
    try {
      await expect(runtime`select 1 from camp_signup`).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.end();
    }
  });
});
