// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readConfig, wranglerConfig } from "../../scripts/config-to-wrangler";

// The camp Worker serves every camp, so it must never hold a binding that could read across
// camps (the platform's Hyperdrive, a service binding to the platform Worker, KV, D1...).
// Anything new here is a deliberate decision: add it to ALLOWED only after that review.
const ALLOWED = new Set(["vars", "hyperdrive", "r2_buckets", "images", "ratelimits"]);
const BINDING_KEYS = [
  "vars",
  "hyperdrive",
  "r2_buckets",
  "images",
  "ratelimits",
  "kv_namespaces",
  "d1_databases",
  "durable_objects",
  "services",
  "queues",
  "analytics_engine_datasets",
  "vectorize",
  "ai",
  "browser",
  "workflows",
  "send_email",
  "secrets_store_secrets",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "version_metadata",
];

// The hosted service's camp Worker config, as its deploys generate it (hosted + staging).
const rawConfig = wranglerConfig("camps", [
  readConfig("hosted"),
  readConfig("staging"),
]) as unknown as Record<string, unknown> & { env?: unknown };
const envs: Array<[string, Record<string, unknown>]> = [
  ["production", rawConfig as Record<string, unknown>],
  ...Object.entries((rawConfig.env ?? {}) as Record<string, Record<string, unknown>>),
];

describe("camp Worker bindings", () => {
  it.each(envs)("%s has only the allowed kinds of binding", (_name, config) => {
    const present = BINDING_KEYS.filter((k) => config[k] !== undefined);
    expect(present.filter((k) => !ALLOWED.has(k))).toEqual([]);
  });

  it.each(envs)("%s binds Hyperdrive only as HYPERDRIVE", (_name, config) => {
    const hyperdrive = (config.hyperdrive ?? []) as Array<{ binding: string }>;
    expect(hyperdrive.map((h) => h.binding)).toEqual(["HYPERDRIVE"]);
  });

  it.each(envs)("%s runs next to the database (targeted placement)", (_name, config) => {
    // Every request makes several sequential round trips to Postgres (Neon, aws-us-west-2).
    expect(config.placement).toEqual({ mode: "targeted", region: "aws:us-west-2" });
  });

  it("staging never uses a production Hyperdrive or bucket, and restricts mail", () => {
    const prod = rawConfig as unknown as {
      hyperdrive: Array<{ id: string }>;
      r2_buckets: Array<{ bucket_name: string }>;
    };
    const staging = (
      rawConfig.env as Record<string, typeof prod & { vars: Record<string, string> }>
    ).staging;
    expect(staging.hyperdrive[0].id).not.toBe(prod.hyperdrive[0].id);
    expect(staging.r2_buckets[0].bucket_name).not.toBe(prod.r2_buckets[0].bucket_name);
    // The allowlist itself is a staging Worker secret, never in config; without it, a
    // restricted instance sends nothing.
    expect(staging.vars.MAIL_RESTRICTED).toBe("true");
    expect(staging.vars.MAIL_ALLOWLIST).toBeUndefined();
    const prodVars = (rawConfig as { vars: Record<string, string> }).vars;
    expect(prodVars.MAIL_RESTRICTED).toBeUndefined();
    expect(prodVars.MAIL_ALLOWLIST).toBeUndefined();
    // The provider is config (its key is a secret).
    expect(prodVars.EMAIL_PROVIDER).toBe("plunk");
    expect(staging.vars.EMAIL_PROVIDER).toBe("plunk");
    expect(prodVars.EMAIL_API_KEY).toBeUndefined();
  });
});
