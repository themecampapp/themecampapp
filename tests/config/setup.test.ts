// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../../config/schema";
import { type Answers, dryRunner, hyperdriveId, setup } from "../../scripts/setup";

// Open-source plan 4.2: scripts/setup.ts, in its dry-run mode: what it would write and run.

const ANSWERS: Answers = {
  name: "owls",
  domain: "example.org",
  product: "Owl Camps",
  operator: "Owl Org",
  contactEmail: "hello@example.org",
  singleCamp: { slug: "dustyowls", host: "camp.example.org" },
  mailProvider: "postmark",
  placementRegion: "aws:us-east-1",
  turnstile: { camps: "site-a", signup: "site-b" },
  firstCamp: {
    name: "Dusty Owls",
    slug: "ignored",
    adminName: "Olive Owl",
    adminEmail: "owl@example.org",
  },
};

async function dryRun(files: Map<string, string>) {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const config = await setup({
    answers: ANSWERS,
    run: dryRunner(log),
    log,
    databaseUrl: "postgres://owner:secret-pw@db.example/tca",
    read: (p) => files.get(p) ?? (p === "config/example.json" ? readFileSync(p, "utf8") : null),
    write: (p, text) => files.set(p, text),
    secret: async (name) => `<${name}>`,
  });
  return { lines, config, commands: lines.filter((l) => l.startsWith("$ ")) };
}

describe("scripts/setup.ts", () => {
  it("writes a valid config from the answers, with the new Hyperdrive ids", async () => {
    const files = new Map<string, string>();
    const { config } = await dryRun(files);
    const written = validateConfig(JSON.parse(files.get("config/owls.json") ?? ""));
    expect(written).toEqual(config);
    expect(config).toMatchObject({
      domain: "example.org",
      workers: { camps: "owls", platform: "owls-platform" },
      singleCamp: { slug: "dustyowls", host: "camp.example.org" },
      mail: { provider: "postmark", authFrom: "signin@auth.example.org" },
      product: { name: "Owl Camps", contactEmail: "hello@example.org" },
      features: { console: false, signupPage: false },
    });
    expect(config.hyperdrive.camps).toMatch(/^[0-9a-f]{32}$/);
    expect(config.hyperdrive.platform).not.toBe(config.hyperdrive.camps);
  });

  it("runs the steps in order, never printing a connection string or secret", async () => {
    const { commands, lines } = await dryRun(new Map());
    const order = [
      "scripts/db-roles.ts",
      "drizzle-kit migrate",
      "scripts/db-grants.ts",
      "hyperdrive create owls-db --caching-disabled",
      "hyperdrive create owls-platform-db --caching-disabled",
      "r2 bucket create owls-files",
      "config-to-wrangler.ts --out-dir . owls",
      "npm run build",
      "check-deploy-target.ts owls",
      "wrangler deploy",
      "secret put BETTER_AUTH_SECRET",
      "secret put EMAIL_WEBHOOK_SECRET",
      "create-camp.ts --instance owls --name Dusty Owls --slug dustyowls --admin Olive Owl <owl@example.org>",
    ];
    let at = -1;
    for (const step of order) {
      const i = commands.findIndex((c, n) => n > at && c.includes(step));
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    expect(lines.join("\n")).not.toContain("secret-pw");
    expect(
      commands.filter((c) => c.includes("secret put")).every((c) => c.endsWith("<<< ***")),
    ).toBe(true);
  });

  it("re-runs without creating what exists", async () => {
    const files = new Map<string, string>();
    await dryRun(files);
    const { commands } = await dryRun(files);
    expect(commands.some((c) => c.includes("hyperdrive create"))).toBe(false);
  });

  it("reads Hyperdrive's id from Wrangler's output", () => {
    expect(
      hyperdriveId('{\n  "binding": "HYPERDRIVE",\n  "id": "0123456789abcdef0123456789abcdef"\n}'),
    ).toBe("0123456789abcdef0123456789abcdef");
    expect(hyperdriveId("error")).toBeNull();
  });
});
