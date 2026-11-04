// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole } from "~/db/schema";
import {
  campCreatedMessage,
  discordEscape,
  notifyOperator,
  signInMessage,
  signInRole,
  signupMessage,
} from "~/lib/notify.server";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  invitePerson,
  post,
  requestLinkToken,
  signIn,
  startWorker,
  type TestWorker,
} from "../helpers/worker";

// Issues #32, #79: the operator's Discord channel hears of new camps and sign-up requests
// (tests/ops/) and of every sign-in, with the camp, role and time only: nothing that
// identifies the person. The test Workers' webhook only accepts messages that can't ping.

describe("Discord messages", () => {
  it("shows the person's highest role, or that they have no camp record", () => {
    expect(signInRole(["lead", "admin", "treasurer"])).toBe("admin");
    expect(signInRole(["treasurer", "lead"])).toBe("lead");
    expect(signInRole(["treasurer"])).toBe("treasurer");
    expect(signInRole([])).toBe("member");
    expect(signInRole(null)).toBe("not_member");
  });

  it("escapes Discord's Markdown in names and shows the time in the reader's zone", () => {
    expect(discordEscape("**Big** _Fish_ ~x~ `y` ||z|| [a](b) \\")).toBe(
      "\\*\\*Big\\*\\* \\_Fish\\_ \\~x\\~ \\`y\\` \\|\\|z\\|\\| \\[a\\](b) \\\\",
    );
    expect(discordEscape("Dusty-Owls & Co (2027)")).toBe("Dusty-Owls & Co (2027)");
    const at = new Date("2027-03-01T17:30:00Z");
    expect(signInMessage("Fish *Camp*", "lead", at)).toBe(
      "🔑 Sign-in · **Fish \\*Camp\\*** · Lead · <t:1803922200:f>",
    );
    expect(campCreatedMessage({ name: "Owls", site: "https://owls.example", year: 2027 })).toBe(
      "⛺ New camp: **Owls** (<https://owls.example>), 2027 season",
    );
    expect(signupMessage({ name: "Owls", organizers: 1, review: "https://ops.example/x" })).toBe(
      "📥 Sign-up request: **Owls** (1 organizer). Review it at <https://ops.example/x>",
    );
  });

  it("sends nothing without a webhook, or to anything that isn't Discord's", async () => {
    expect(await notifyOperator(undefined, "hi")).toBe(false);
    expect(await notifyOperator("https://example.com/api/webhooks/1/x", "hi")).toBe(false);
    expect(await notifyOperator("http://discord.com/api/webhooks/1/x", "hi")).toBe(false);
    expect(await notifyOperator("https://hooks.slack.com/services/T/B/x", "hi")).toBe(false);
  });
});

describe("sign-in notifications through the real Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  // Posted after the response: wait until there are this many (or 3 seconds).
  const posted = async (n: number) => {
    for (let i = 0; i < 60 && w.discord.length < n; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return w.discord;
  };

  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    for (const [key, roles] of [
      ["member", []],
      ["lead", ["lead", "treasurer"]],
      ["admin", ["admin", "lead"]],
    ] as const) {
      const p = await invitePerson(t, `${key}@example.com`, {
        legalName: `Secret ${key} Name`,
        playaName: `Playa${key}`,
      });
      for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
    }
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("posts the camp, role and time for each sign-in, and nothing about the person", async () => {
    for (const [i, key] of ["member", "lead", "admin"].entries()) {
      await signIn(w, `${key}@example.com`);
      await posted(i + 1); // in order
    }
    expect(w.discord.map((m) => m.replace(/ · <t:\d+:f>$/, ""))).toEqual([
      "🔑 Sign-in · **Test Camp** · Member",
      "🔑 Sign-in · **Test Camp** · Lead",
      "🔑 Sign-in · **Test Camp** · Admin",
    ]);
    for (const m of w.discord) {
      expect(m).toMatch(/<t:\d+:f>$/);
      expect(m).not.toMatch(/example\.com|Secret|Playa/);
    }
  });

  it("posts nothing for a sign-in that fails", async () => {
    const before = (await posted(3)).length;
    const token = await requestLinkToken(w, "member@example.com");
    await w.fetch(post("/sign-in/confirm", { token }));
    const reused = await w.fetch(post("/sign-in/confirm", { token }));
    expect(reused.headers.get("location")).toContain("/sign-in/error");
    await w.fetch(post("/sign-in/confirm", { token: "not-a-token" }));
    await posted(before + 1);
    await new Promise((r) => setTimeout(r, 300)); // time for any wrongly posted ones
    expect(w.discord.length).toBe(before + 1); // the first use only
  });
});
