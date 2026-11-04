// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Sets up a new instance, doing what docs/self-hosting.md describes that can be automated (open-
// source plan 4.2): writes config/<name>.json from your answers, creates the database roles,
// migrations and grants, creates the Hyperdrive configs and R2 bucket, generates the Wrangler
// configs, deploys both Workers, puts their secrets, and creates the first camp.
//   DATABASE_URL=<owner> npx tsx scripts/setup.ts [--answers answers.json] [--dry-run]
// It's safe to re-run: an existing config is reused, ids already in it aren't created again, an
// existing bucket is fine, and secrets the Workers already have are left alone. --dry-run prints
// every command instead of running it and writes nothing. --answers takes the answers from a
// JSON file (the shape is `Answers` below) instead of asking.
// What it can't do for you: DNS, the Turnstile widgets (their keys are asked for), the email
// provider's account, domains and webhook, and Cloudflare Access. docs/self-hosting.md covers them.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { type InstanceConfig, validateConfig } from "../config/schema";

export type Answers = {
  name: string; // the config's name: config/<name>.json
  domain: string;
  product: string;
  operator: string;
  contactEmail: string;
  // One camp at its own host, or null for many camps at <slug>.<domain>.
  singleCamp: { slug: string; host: string } | null;
  mailProvider: "postmark" | "plunk";
  placementRegion: string;
  turnstile: { camps: string; signup: string };
  firstCamp: { name: string; slug: string; adminName: string; adminEmail: string } | null;
};

// Runs a command and returns its output. The dry run's prints it and returns what's given.
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; env?: Record<string, string>; secret?: boolean },
) => string;

export type Setup = {
  answers: Answers;
  run: Runner;
  log: (line: string) => void;
  write: (path: string, text: string) => void;
  read: (path: string) => string | null;
  secret: (name: string, why: string) => Promise<string>;
  databaseUrl: string;
};

const PLACEHOLDER = /^</;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

// The instance config from the answers, on the template's defaults.
export function configFrom(a: Answers, template: InstanceConfig): InstanceConfig {
  const { $comment: _, ...rest } = template as InstanceConfig & { $comment?: string };
  return validateConfig(
    {
      ...rest,
      domain: a.domain,
      workers: { camps: a.name, platform: `${a.name}-platform` },
      bucket: `${a.name}-files`,
      placementRegion: a.placementRegion,
      turnstile: a.turnstile,
      mail: {
        ...template.mail,
        provider: a.mailProvider,
        from: `notify@mail.${a.domain}`,
        authFrom: `signin@auth.${a.domain}`,
        alertFrom: `notify@mail.${a.domain}`,
      },
      product: {
        ...template.product,
        name: a.product,
        operator: a.operator,
        contactEmail: a.contactEmail,
        reservedSlugs: [],
        reservedParts: [],
      },
      // The console needs Cloudflare Access, which this doesn't set up; turn it on later.
      features: { ...template.features, console: false, signupPage: false },
      singleCamp: a.singleCamp,
    },
    `config/${a.name}.json`,
  );
}

// A database URL with another role and password.
const asRole = (url: string, role: string, password: string) => {
  const u = new URL(url);
  u.username = role;
  u.password = password;
  return u.toString();
};

// The id in `wrangler hyperdrive create`'s output (it prints the config snippet to add).
export const hyperdriveId = (output: string) =>
  output.match(/"id":\s*"([0-9a-f]{32})"/)?.[1] ?? null;

export async function setup(s: Setup) {
  const { answers: a, run, log } = s;
  const path = `config/${a.name}.json`;

  // 1. The config: reused when it exists, otherwise written from the answers.
  const existing = s.read(path);
  let config: InstanceConfig;
  if (existing) {
    config = validateConfig(JSON.parse(existing), path);
    log(`Using ${path}.`);
  } else {
    const template = JSON.parse(s.read("config/example.json") ?? "{}") as InstanceConfig;
    config = configFrom(a, template);
    s.write(path, `${JSON.stringify(config, null, 2)}\n`);
    log(`Wrote ${path}.`);
  }
  const save = () => s.write(path, `${JSON.stringify(config, null, 2)}\n`);

  // 2. The database: roles (new passwords only when Hyperdrive still needs them), migrations,
  // grants.
  const needHyperdrive = PLACEHOLDER.test(config.hyperdrive.camps);
  const passwords = needHyperdrive ? { runtime: hex(24), platform: hex(24) } : null;
  const dbEnv = { DATABASE_URL: s.databaseUrl };
  run("npx", ["tsx", "scripts/db-roles.ts"], {
    env: passwords
      ? {
          ...dbEnv,
          APP_RUNTIME_PASSWORD: passwords.runtime,
          APP_PLATFORM_PASSWORD: passwords.platform,
        }
      : dbEnv,
  });
  run("npx", ["drizzle-kit", "migrate"], { env: dbEnv });
  run("npx", ["tsx", "scripts/db-grants.ts"], { env: dbEnv });

  // 3. Cloudflare: Hyperdrive (caching off, one per Worker, each as its own role) and R2.
  if (passwords) {
    for (const [worker, role, password] of [
      ["camps", "app_runtime", passwords.runtime],
      ["platform", "app_platform", passwords.platform],
    ] as const) {
      const out = run(
        "npx",
        [
          "wrangler",
          "hyperdrive",
          "create",
          `${config.workers[worker]}-db`,
          "--caching-disabled",
          `--connection-string=${asRole(s.databaseUrl, role, password)}`,
        ],
        { secret: true },
      );
      const id = hyperdriveId(out);
      if (!id) throw new Error(`Couldn't read the new Hyperdrive id from Wrangler:\n${out}`);
      config.hyperdrive[worker] = id;
    }
    save();
    log("Created the Hyperdrive configs.");
  }
  try {
    run("npx", ["wrangler", "r2", "bucket", "create", config.bucket]);
  } catch (e) {
    if (!/already exists/i.test(String((e as { stderr?: string }).stderr ?? e))) throw e;
    log(`The bucket ${config.bucket} already exists.`);
  }

  // 4. The Wrangler configs, the build, the target check and the deploy.
  run("npx", ["tsx", "scripts/config-to-wrangler.ts", "--out-dir", ".", a.name]);
  run("npm", ["run", "build"]);
  run("npx", ["tsx", "scripts/check-deploy-target.ts", a.name]);
  run("npx", ["wrangler", "deploy"]);
  run("npx", ["wrangler", "deploy"], { cwd: "platform" });

  // 5. Secrets the Workers don't have yet.
  const has = (cwd: string) => {
    try {
      const list = JSON.parse(
        run("npx", ["wrangler", "secret", "list", "--format", "json"], { cwd }) || "[]",
      );
      return new Set((list as Array<{ name: string }>).map((x) => x.name));
    } catch {
      return new Set<string>();
    }
  };
  const camps = has(".");
  const platform = has("platform");
  const put = (cwd: string, name: string, value: string) =>
    run("npx", ["wrangler", "secret", "put", name], { cwd, input: value, secret: true });
  const webhookSecret = hex(24);
  const emailKey =
    camps.has("EMAIL_API_KEY") && platform.has("EMAIL_API_KEY")
      ? null
      : await s.secret("EMAIL_API_KEY", `your ${config.mail.provider} API key`);
  if (!camps.has("BETTER_AUTH_SECRET"))
    put(".", "BETTER_AUTH_SECRET", randomBytes(48).toString("base64"));
  if (emailKey && !camps.has("EMAIL_API_KEY")) put(".", "EMAIL_API_KEY", emailKey);
  if (emailKey && !platform.has("EMAIL_API_KEY")) put("platform", "EMAIL_API_KEY", emailKey);
  if (!camps.has("TURNSTILE_SECRET")) {
    put(
      ".",
      "TURNSTILE_SECRET",
      await s.secret("TURNSTILE_SECRET", "the join pages' Turnstile widget's secret"),
    );
  }
  if (!platform.has("TURNSTILE_SECRET")) {
    put(
      "platform",
      "TURNSTILE_SECRET",
      await s.secret("TURNSTILE_SECRET", "the sign-up Turnstile widget's secret"),
    );
  }
  if (!platform.has("OPERATOR_EMAIL")) {
    put(
      "platform",
      "OPERATOR_EMAIL",
      await s.secret("OPERATOR_EMAIL", "where health alerts go (you)"),
    );
  }
  if (!platform.has("EMAIL_WEBHOOK_SECRET")) {
    put("platform", "EMAIL_WEBHOOK_SECRET", webhookSecret);
    log(
      `The bounce webhook's secret is ${webhookSecret}: add it to your ${config.mail.provider} webhook ("Email" in docs/operating.md).`,
    );
  }

  // 6. The first camp, if asked for.
  if (a.firstCamp) {
    const c = a.firstCamp;
    run(
      "npx",
      [
        "tsx",
        "scripts/create-camp.ts",
        "--instance",
        a.name,
        "--name",
        c.name,
        "--slug",
        config.singleCamp?.slug ?? c.slug,
        "--admin",
        `${c.adminName} <${c.adminEmail}>`,
      ],
      { env: { ...dbEnv, ...(emailKey ? { EMAIL_API_KEY: emailKey } : {}) }, secret: true },
    );
  }
  log(
    "Done. Next: DNS, your email provider's domains and webhook, then sign in (docs/self-hosting.md).",
  );
  return config;
}

// The real runner: the command's output, or an error carrying its stderr.
const realRunner: Runner = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

// The dry run's: prints the command (never a secret) and returns a stand-in output.
export function dryRunner(log: (line: string) => void): Runner {
  let n = 0;
  return (cmd, args, opts = {}) => {
    const shown = opts.secret
      ? args.map((x) => (x.includes("://") ? "<connection string>" : x))
      : args;
    log(
      `$ ${opts.cwd ? `(cd ${opts.cwd}) ` : ""}${cmd} ${shown.join(" ")}${opts.input ? " <<< ***" : ""}`,
    );
    if (args[1] === "hyperdrive") return `"id": "${String(++n).padStart(32, "0")}"`;
    if (args.includes("list")) return "[]";
    return "";
  };
}

async function main() {
  const { values } = parseArgs({
    options: { answers: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const dry = values["dry-run"] === true;
  const databaseUrl = process.env.DATABASE_URL ?? (dry ? "postgres://owner:x@db.example/tca" : "");
  if (!databaseUrl) {
    console.error(
      "Set DATABASE_URL to the database owner's connection (docs/self-hosting.md, step 4).",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = "") =>
    (await rl.question(`${q}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  try {
    let answers: Answers;
    if (values.answers) {
      answers = JSON.parse(readFileSync(values.answers, "utf8")) as Answers;
    } else {
      const name = await ask("A short name for this instance (letters, digits, hyphens)", "mine");
      const domain = await ask("Your domain, on Cloudflare");
      const one = (await ask("One camp, or many? (one/many)", "many")) === "one";
      const singleCamp = one
        ? { slug: await ask("The camp's slug"), host: await ask("The camp's host", domain) }
        : null;
      answers = {
        name,
        domain,
        product: await ask("What your instance is called", "Theme Camp App"),
        operator: await ask("Who runs it"),
        contactEmail: await ask("A contact address that receives mail", `hello@${domain}`),
        singleCamp,
        mailProvider: (await ask(
          "Email provider (postmark/plunk)",
          "postmark",
        )) as Answers["mailProvider"],
        placementRegion: await ask("The cloud region nearest your database", "aws:us-east-1"),
        turnstile: {
          camps: await ask("The join pages' Turnstile site key"),
          signup: await ask("The sign-up page's Turnstile site key (or the same one)"),
        },
        firstCamp:
          (await ask("Create the first camp now? (y/n)", "y")) === "y"
            ? {
                name: await ask("Its name"),
                slug: singleCamp?.slug ?? (await ask("Its slug")),
                adminName: await ask("Its first Admin's name"),
                adminEmail: await ask("Their email"),
              }
            : null,
      };
    }
    const log = (line: string) => console.log(line);
    await setup({
      answers,
      run: dry ? dryRunner(log) : realRunner,
      log,
      databaseUrl,
      read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: dry
        ? (p, text) => log(`(would write ${p})\n${text}`)
        : (p, text) => writeFileSync(p, text),
      secret: dry ? async (name) => `<${name}>` : (name, why) => ask(`${name}: ${why}`),
    });
  } finally {
    rl.close();
  }
}

if (process.argv[1]?.endsWith("setup.ts")) await main();
