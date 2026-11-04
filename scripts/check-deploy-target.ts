// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails unless both built Workers target the expected instance. The Cloudflare Vite plugin
// bakes the environment (CLOUDFLARE_ENV at build time) into build/server/wrangler.json, and
// `wrangler deploy` uses that file, so a build without CLOUDFLARE_ENV=staging would deploy the
// production Workers. Run between the build and the deploy.
//   tsx scripts/check-deploy-target.ts <instance>      (e.g. staging; "production" means hosted)
// The expected Worker names and zone come from config/<instance>.json (open-source plan 2.3).
import { readFileSync } from "node:fs";
import { readConfig } from "./config-to-wrangler";

const target = process.argv[2];
if (!target) throw new Error("usage: check-deploy-target.ts <instance>");
const config = readConfig(target === "production" ? "hosted" : target);
const expected = {
  camps: config.workers.camps,
  platform: config.workers.platform,
  zone: config.domain,
  single: config.singleCamp !== null,
};

let ok = true;
for (const [worker, file] of [
  ["camps", "build/server/wrangler.json"],
  ["platform", "platform/build/server/wrangler.json"],
] as const) {
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    name: string;
    routes?: Array<{ zone_name: string }>;
  };
  const zones = [...new Set((config.routes ?? []).map((r) => r.zone_name))];
  // A single-camp instance's platform Worker has no routes, only its cron (open-source plan 3.4).
  const wantZones = worker === "platform" && expected.single ? [] : [expected.zone];
  const good = config.name === expected[worker] && zones.join() === wantZones.join();
  console.log(`${good ? "ok" : "WRONG"} ${file}: ${config.name} on ${zones.join(", ") || "no routes"}`);
  ok &&= good;
}
if (!ok) {
  console.error(`The build doesn't target ${target}; refusing to deploy.`);
  process.exit(1);
}
