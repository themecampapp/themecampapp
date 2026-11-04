// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Turns instance configs (config/*.json, config/schema.ts) into the two Workers' Wrangler
// configs (open-source plan, Unit 2.2). The first config is the top level; any others become
// Wrangler environments named by their `wranglerEnv` (the hosted service: hosted + staging).
//
//   npm run config:local    (development and tests; also run by postinstall)
//   npm run config:hosted   (the hosted service's deploys: hosted + staging)
//   tsx scripts/config-to-wrangler.ts --out-dir <dir> <instance> [<instance>…]
//
// writes <dir>/wrangler.jsonc (camp Worker) and <dir>/platform/wrangler.jsonc. Both are
// generated and gitignored: change config/*.json, never the generated files. Before the switch
// (2026-10-11), a test proved hosted + staging reproduced the hand-written files exactly.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { featureVars } from "../app/lib/instance-features";
import { type InstanceConfig, validateConfig } from "../config/schema";

// Settings that are the code's, not the instance's.
const COMPATIBILITY = { compatibility_date: "2026-09-23", compatibility_flags: ["nodejs_compat"] };
const LOCAL_DATABASE = "postgres://test:test@localhost:54339/test";
const CONFIG_DIR = fileURLToPath(new URL("../config/", import.meta.url));

export function readConfig(name: string): InstanceConfig {
  const path = join(CONFIG_DIR, `${name}.json`);
  return validateConfig(JSON.parse(readFileSync(path, "utf8")), `config/${name}.json`);
}

const limiter = (name: string, namespace: string) => [
  { name, namespace_id: namespace, simple: { limit: 5, period: 60 } },
];
// Who runs the instance and what it's called (open-source plan 2.4). An empty SUPPORT_URL means
// none: the app's community links don't appear.
// A single-camp instance's camp (open-source plan 3.4); empty on a multi-camp one.
const single = (c: InstanceConfig) => ({
  SINGLE_CAMP_SLUG: c.singleCamp?.slug ?? "",
  SINGLE_CAMP_HOST: c.singleCamp?.host ?? "",
});
const product = (c: InstanceConfig) => ({
  PRODUCT_NAME: c.product.name,
  OPERATOR_NAME: c.product.operator,
  CONTACT_EMAIL: c.product.contactEmail,
  SUPPORT_URL: c.product.supportUrl ?? "",
  // Its source code, linked from every page (AGPL section 13).
  SOURCE_URL: c.product.sourceUrl,
  // Its legal pages' folder under legal/, and whether the pilot agreement applies (3.6).
  LEGAL_DIR: c.legal.dir,
  // Its icon's folder under icons/ (3.5).
  ICON_DIR: c.product.icon,
  PILOT_AGREEMENT: c.legal.pilotAgreement ? "true" : "false",
  // The hosted-only features (3.7): both Workers get all of them, for the legal pages too.
  ...featureVars({
    signupPage: c.features.signupPage,
    feedback: c.features.feedback,
    usage: c.features.usage,
    discord: c.features.discord,
  }),
});
// The email provider (open-source plan 3.1; its API key is the EMAIL_API_KEY secret). Staging
// sends only to the MAIL_ALLOWLIST secret, and to nobody while it's missing.
const mail = (c: InstanceConfig) => ({
  EMAIL_PROVIDER: c.mail.provider,
  ...(c.mail.restricted ? { MAIL_RESTRICTED: "true" } : {}),
});
const hyperdrive = (binding: string, id: string) => [
  { binding, id, localConnectionString: LOCAL_DATABASE },
];

// What a Wrangler environment block needs for each Worker. Environments don't inherit
// bindings, routes, vars or triggers, so each block carries all of them.
function campsBlock(c: InstanceConfig) {
  return {
    name: c.workers.camps,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: `${c.singleCamp?.host ?? `*.${c.domain}`}/*`, zone_name: c.domain }],
    vars: {
      APP_HOST_SUFFIX: c.domain,
      // Every request replaces this with its own camp's origin (workers/app.ts).
      APP_URL: `https://${c.domain}`,
      MAIL_FROM: c.mail.from,
      AUTH_MAIL_FROM: c.mail.authFrom,
      TURNSTILE_SITE_KEY: c.turnstile.camps,
      ...single(c),
      ...product(c),
      ...mail(c),
    },
    ratelimits: limiter("JOIN_LIMITER", c.rateLimits.join),
    hyperdrive: hyperdrive("HYPERDRIVE", c.hyperdrive.camps),
    r2_buckets: [{ binding: "PHOTOS", bucket_name: c.bucket }],
    images: { binding: "IMAGES" },
    placement: { mode: "targeted", region: c.placementRegion },
    triggers: { crons: [c.crons.camps] },
  };
}

// The platform Worker's vars; scripts/create-camp.ts uses them too, as the Worker would.
export function platformVars(c: InstanceConfig) {
  return {
    PLATFORM_DOMAIN: c.domain,
    ALERT_MAIL_FROM: c.mail.alertFrom,
    // While either is empty, the console refuses everyone.
    ACCESS_TEAM_DOMAIN: c.access?.teamDomain ?? "",
    ACCESS_AUD: c.access?.aud ?? "",
    // "false": no console at all; ops.<domain> answers 404 (open-source plan 3.3).
    CONSOLE: c.features.console ? "true" : "false",
    TURNSTILE_SITE_KEY: c.turnstile.signup,
    ...product(c),
    // Camp addresses that could pass for this instance (the console and sign-up check them).
    RESERVED_SLUGS: c.product.reservedSlugs.join(","),
    RESERVED_PARTS: c.product.reservedParts.join(","),
    ...single(c),
    ...mail(c),
  };
}

function platformBlock(c: InstanceConfig) {
  // A single-camp instance's platform Worker has no routes: the camp has the host, and the
  // Worker runs only its hourly jobs.
  const hosts = c.singleCamp
    ? []
    : [c.domain, `www.${c.domain}`, `ops.${c.domain}`, `signup.${c.domain}`];
  return {
    name: c.workers.platform,
    workers_dev: false,
    preview_urls: false,
    routes: hosts.map((host) => ({ pattern: `${host}/*`, zone_name: c.domain })),
    vars: platformVars(c),
    ratelimits: limiter("SIGNUP_LIMITER", c.rateLimits.signup),
    hyperdrive: hyperdrive("HYPERDRIVE_PLATFORM", c.hyperdrive.platform),
    r2_buckets: [{ binding: "FILES", bucket_name: c.bucket }],
    placement: { mode: "targeted", region: c.placementRegion },
    triggers: { crons: [c.crons.platform] },
  };
}

export function wranglerConfig(worker: "camps" | "platform", configs: InstanceConfig[]) {
  const [top, ...rest] = configs;
  if (!top) throw new Error("at least one instance config is needed");
  if (top.wranglerEnv !== null) throw new Error("the first config must be the top level");
  const block = worker === "camps" ? campsBlock : platformBlock;
  const env: Record<string, ReturnType<typeof block>> = {};
  for (const c of rest) {
    if (!c.wranglerEnv) throw new Error("only the first config may be the top level");
    env[c.wranglerEnv] = block(c);
  }
  return {
    $schema:
      worker === "camps"
        ? "node_modules/wrangler/config-schema.json"
        : "../node_modules/wrangler/config-schema.json",
    ...COMPATIBILITY,
    main: "./workers/app.ts",
    observability: { enabled: true },
    upload_source_maps: true,
    ...block(top),
    ...(rest.length ? { env } : {}),
  };
}

const HEADER =
  "// Generated by scripts/config-to-wrangler.ts from config/*.json. Don't edit: change the\n" +
  "// instance config and regenerate.\n";

export function writeWrangler(outDir: string, configs: InstanceConfig[]) {
  for (const [worker, file] of [
    ["camps", "wrangler.jsonc"],
    ["platform", "platform/wrangler.jsonc"],
  ] as const) {
    const path = join(outDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${HEADER}${JSON.stringify(wranglerConfig(worker, configs), null, 2)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out-dir");
  const outDir = at >= 0 ? args[at + 1] : undefined;
  const names = args.filter((_, i) => i !== at && i !== at + 1);
  if (!outDir || !names.length) {
    console.error("usage: config-to-wrangler.ts --out-dir <dir> <instance> [<instance>…]");
    process.exit(1);
  }
  writeWrangler(outDir, names.map(readConfig));
  console.log(
    `wrote ${outDir}/wrangler.jsonc and ${outDir}/platform/wrangler.jsonc from ${names.join(", ")}`,
  );
}
