// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateConfig } from "../../config/schema";
import { createCamp } from "../../platform/app/lib/camps.server";
import { platformVars, readConfig } from "../../scripts/config-to-wrangler";
import { parseAdmin } from "../../scripts/create-camp";
import { APP_HOST_SUFFIX, stubMail } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { TEST_EMAIL_ENV } from "../helpers/mail";
import { startPlatform } from "../helpers/platform";

// Open-source plan 3.3: an instance can run without the operator console (features.console),
// and camps can be created from the command line instead (scripts/create-camp.ts).

const run = promisify(execFile);
let t: TestDb;
let owner: ReturnType<typeof postgres>;

beforeAll(async () => {
  t = await createTestDb();
  owner = postgres(t.url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await owner.end();
  await t.drop();
});

describe("an instance without the console", () => {
  let platform: Awaited<ReturnType<typeof startPlatform>>;
  beforeAll(async () => {
    platform = await startPlatform(t, "nobody@example.com", { CONSOLE: "false" });
  });
  afterAll(async () => platform.dispose());

  it("answers 404 on the console's host, even with a valid Access token", async () => {
    for (const path of ["/", "/ops", "/ops.data", "/ops/log", "/ops/camps/new", "/__manifest"]) {
      expect((await platform.consoleGet(path)).status, path).toBe(404);
    }
    expect((await platform.consolePost("/ops/camps/new", { name: "X" })).status).toBe(404);
  });

  it("still serves the public site, the legal pages and the email webhooks", async () => {
    expect((await platform.site("/")).status).toBe(200);
    expect((await platform.site("/legal/terms")).status).toBe(200);
    // No bearer secret: refused by the webhook itself, so it's routed.
    const hook = await platform.site("/webhooks/email/plunk/bounce", {});
    expect(hook.status).not.toBe(404);
  });

  it("is what the config's features.console turns off", () => {
    expect(platformVars(readConfig("hosted")).CONSOLE).toBe("true");
    expect(platformVars(readConfig("example")).CONSOLE).toBe("false");
  });

  it("can't have the sign-up page, since sign-ups are decided in the console", () => {
    const raw = structuredClone(readConfig("example")) as unknown as {
      features: { signupPage: boolean; console: boolean };
    };
    raw.features = { signupPage: true, console: false };
    expect(() => validateConfig(raw)).toThrow(/signupPage needs features.console/);
  });
});

describe("creating a camp from the command line", () => {
  const env = {
    ...platformVars(readConfig("local")),
    PLATFORM_DOMAIN: APP_HOST_SUFFIX,
    ...TEST_EMAIL_ENV,
  } as unknown as PlatformEnv;

  it("reads an Admin as a name and an address", () => {
    expect(parseAdmin("Olive Owl <owl@example.com>")).toEqual({
      name: "Olive Owl",
      email: "owl@example.com",
    });
    expect(parseAdmin("owl@example.com")).toEqual({ name: "", email: "owl@example.com" });
  });

  it("creates the camp, invites its Admins, and logs it as the command line", async () => {
    const { sent } = stubMail();
    const created = await createCamp(owner, env, "cli", {
      name: "Night Herons",
      slug: "nightherons",
      admins: [
        { name: "Hal Heron", email: "hal@example.com" },
        { name: "Ida Ibis", email: "ida@example.com" },
      ],
      year: String(new Date().getUTCFullYear() + 1),
    });
    expect(created.invited).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual(["hal@example.com", "ida@example.com"]);
    expect(sent[0].text).toContain(`https://nightherons.${APP_HOST_SUFFIX}/sign-in`);

    const invites = await owner`
      select i.email, i.status from invite i where i.camp_id = ${created.id} order by 1`;
    expect(invites.map((i) => [i.email, i.status])).toEqual([
      ["hal@example.com", "pending"],
      ["ida@example.com", "pending"],
    ]);
    const [audit] = await owner`
      select actor_type, actor_operator_id from audit_log
      where camp_id = ${created.id} and action = 'camp_created'`;
    expect(audit).toEqual({ actor_type: "system", actor_operator_id: null });
    const [log] = await owner`
      select operator_id, kind from operator_log where subject_camp_id = ${created.id}`;
    expect(log).toEqual({ operator_id: null, kind: "cli" });

    // An instance that does run the console shows it in the operator log.
    const platform = await startPlatform(t, "op@example.com");
    try {
      const page = await (await platform.consoleGet("/ops/log")).text();
      expect(page).toContain("Command line");
      expect(page).toContain("nightherons");
    } finally {
      await platform.dispose();
    }
  });

  it("works as a command, and explains a refusal", async () => {
    const cmd = (args: string[]) =>
      run("npx", ["tsx", "scripts/create-camp.ts", "--instance", "local", ...args], {
        env: { ...process.env, DATABASE_URL: t.url, EMAIL_API_KEY: "" },
      });
    const ok = await cmd([
      "--name",
      "Sand Larks",
      "--slug",
      "sandlarks",
      "--admin",
      "Liv Lark <liv@example.com>",
    ]);
    // No EMAIL_API_KEY: created, but nobody emailed.
    expect(ok.stdout).toContain("Created, but 1 of the invite emails");
    const [c] = await owner`select name from camp where slug = 'sandlarks'`;
    expect(c.name).toBe("Sand Larks");

    const refused = await cmd([
      "--name",
      "Ops",
      "--slug",
      "ops",
      "--admin",
      "liv@example.com",
    ]).catch((e: { code: number; stderr: string }) => e);
    expect(refused).toMatchObject({ code: 1 });
    expect((refused as { stderr: string }).stderr).toContain("reserved");
  }, 60000);
});
