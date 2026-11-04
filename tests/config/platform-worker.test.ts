// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readConfig, wranglerConfig } from "../../scripts/config-to-wrangler";

// The platform Worker answers only for its own domain (PLATFORM_DOMAIN), so that value must
// match the zone its routes are in, and staging must never share production resources.
type Config = {
  vars: { PLATFORM_DOMAIN: string };
  routes: Array<{ pattern: string; zone_name: string }>;
  hyperdrive: Array<{ binding: string; id: string }>;
  r2_buckets: Array<{ bucket_name: string }>;
};

// The hosted service's platform Worker config, as its deploys generate it (hosted + staging).
const rawConfig = wranglerConfig("platform", [readConfig("hosted"), readConfig("staging")]);
const prod = rawConfig as unknown as Config;
const staging = (rawConfig.env as unknown as { staging: Config }).staging;

describe("platform Worker config", () => {
  it.each([
    ["production", prod, "themecamp.app"],
    ["staging", staging, "themecamp.dev"],
  ] as const)(
    "%s serves only the apex, www, ops and signup of its own domain",
    (_n, config, domain) => {
      expect(config.vars.PLATFORM_DOMAIN).toBe(domain);
      expect(config.routes).toEqual(
        [domain, `www.${domain}`, `ops.${domain}`, `signup.${domain}`].map((host) => ({
          pattern: `${host}/*`,
          zone_name: domain,
        })),
      );
    },
  );

  it.each([
    ["production", prod],
    ["staging", staging],
  ] as const)("%s runs next to the database (targeted placement)", (_n, config) => {
    expect((config as unknown as { placement: unknown }).placement).toEqual({
      mode: "targeted",
      region: "aws:us-west-2",
    });
  });

  it("staging never uses a production Hyperdrive or bucket", () => {
    expect(staging.hyperdrive[0].id).not.toBe(prod.hyperdrive[0].id);
    expect(staging.r2_buckets[0].bucket_name).not.toBe(prod.r2_buckets[0].bucket_name);
    expect(prod.hyperdrive.map((h) => h.binding)).toEqual(["HYPERDRIVE_PLATFORM"]);
  });

  it("staging restricts mail; production doesn't, and neither holds an allowlist", () => {
    const vars = (c: Config) => c.vars as unknown as Record<string, string | undefined>;
    expect(vars(staging).MAIL_RESTRICTED).toBe("true");
    expect(vars(prod).MAIL_RESTRICTED).toBeUndefined();
    expect(vars(staging).MAIL_ALLOWLIST).toBeUndefined();
    expect(vars(prod).EMAIL_PROVIDER).toBe("plunk");
    expect(vars(staging).EMAIL_PROVIDER).toBe("plunk");
  });
});
