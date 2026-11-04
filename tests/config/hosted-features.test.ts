// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { featureVars } from "~/lib/instance-features";
import { legalText } from "~/lib/legal";
import { readConfig, wranglerConfig } from "../../scripts/config-to-wrangler";
import { createTestDb, type TestDb } from "../helpers/db";
import { startPlatform } from "../helpers/platform";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Open-source plan 3.7: the hosted service's own pieces (the sign-up page, in-app feedback, usage
// counts and Discord notifications) are each on or off per instance.

const OFF = { SIGNUP_PAGE: "false", FEEDBACK: "false", USAGE_COUNTS: "false", DISCORD: "false" };

describe("the config", () => {
  it("turns every feature on for the hosted service and staging, and off in the example", () => {
    const on = { SIGNUP_PAGE: "true", FEEDBACK: "true", USAGE_COUNTS: "true", DISCORD: "true" };
    const instances = [readConfig("hosted"), readConfig("staging")];
    for (const worker of ["camps", "platform"] as const) {
      const config = wranglerConfig(worker, instances) as unknown as {
        vars: Record<string, string>;
        env: { staging: { vars: Record<string, string> } };
      };
      expect(config.vars, worker).toMatchObject(on);
      expect(config.env.staging.vars, `${worker} staging`).toMatchObject(on);
    }
    expect(wranglerConfig("platform", [readConfig("example")]).vars).toMatchObject(OFF);
  });

  it("is a var that must be exactly true", () => {
    expect(featureVars({ signupPage: true, feedback: false, usage: true, discord: false })).toEqual(
      { SIGNUP_PAGE: "true", FEEDBACK: "false", USAGE_COUNTS: "true", DISCORD: "false" },
    );
  });
});

describe("the legal templates", () => {
  const env = { LEGAL_DIR: "templates", PRODUCT_NAME: "Example Camps" };

  it("mention each feature only when it's on", () => {
    const off = legalText({ ...env, ...OFF }, "privacy") ?? "";
    for (const gone of ["Usage counts", "sign-up request", "Feedback you send us", "Discord"]) {
      expect(off, gone).not.toContain(gone);
    }
    expect(off).not.toContain("{feature:");
    const on = legalText({ ...env, FEEDBACK: "true", DISCORD: "true" }, "privacy") ?? "";
    expect(on).toContain("Feedback you send us");
    expect(on).toContain("**Feedback** is kept for 12 months.\n");
    expect(on).toContain("Discord");
    expect(on).not.toContain("Usage counts");
    expect(on).not.toContain("{feature:");
  });
});

describe("an instance without them", () => {
  let t: TestDb;
  let w: TestWorker;
  let platform: Awaited<ReturnType<typeof startPlatform>>;
  let cookie: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t, OFF);
    platform = await startPlatform(t, undefined, OFF);
    await invitePerson(t, "quiet@example.com");
    cookie = await signIn(w, "quiet@example.com");
  });
  afterAll(async () => {
    await platform.dispose();
    await w.dispose();
    await t.drop();
  });

  it("has no sign-up page, and the public site doesn't link one", async () => {
    expect((await platform.site("/signup")).status).toBe(404);
    expect((await platform.site("/signup/thanks")).status).toBe(404);
    const home = await platform.site("/");
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain('href="/signup"');
  });

  it("takes no feedback, and doesn't offer it", async () => {
    expect((await w.fetch(get("/feedback", cookie))).status).toBe(404);
    const page = await (await w.fetch(get("/profile", cookie))).text();
    expect(page).not.toContain("Send feedback about");
  });

  it("posts nothing to Discord when someone signs in", () => {
    expect(w.discord).toEqual([]);
  });

  it("keeps no usage counts", async () => {
    await w.fetch(get("/", cookie));
    await new Promise((r) => setTimeout(r, 200));
    const [n] = await t.client`select count(*)::int as n from usage_daily`;
    expect(n.n).toBe(0);
  });

  it("still serves the public site's other pages", async () => {
    expect((await platform.site("/legal/privacy")).status).toBe(200);
    expect((await w.fetch(get("/", cookie))).status).toBe(200);
  });
});
