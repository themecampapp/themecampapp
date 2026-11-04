// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The hosted service's own pieces, each on or off per instance (config `features`, open-source
// plan 3.7). Each reaches the Workers as a var that must be exactly "true", so a missing one is
// off. The console (CONSOLE) is checked in the platform Worker itself.
//   signupPage  the public sign-up page (platform Worker, SIGNUP_PAGE)
//   feedback    in-app feedback to the operator (FEEDBACK)
//   usage       the usage counts per camp per day, shown in the console (USAGE_COUNTS)
//   discord     notifications to the operator's Discord (DISCORD; the webhook is a secret)
const VARS = {
  signupPage: "SIGNUP_PAGE",
  feedback: "FEEDBACK",
  usage: "USAGE_COUNTS",
  discord: "DISCORD",
} as const;
export type InstanceFeature = keyof typeof VARS;
export type FeaturesEnv = { [K in (typeof VARS)[InstanceFeature]]?: string };

export const featureOn = (env: FeaturesEnv, feature: InstanceFeature) =>
  env[VARS[feature]] === "true";

// The Discord webhook to notify, or undefined when the instance doesn't use Discord.
export const discordWebhook = (env: FeaturesEnv & { DISCORD_WEBHOOK_URL?: string }) =>
  featureOn(env, "discord") ? env.DISCORD_WEBHOOK_URL : undefined;

// The var each feature becomes (scripts/config-to-wrangler.ts).
export function featureVars(features: Record<InstanceFeature, boolean>) {
  return Object.fromEntries(
    (Object.keys(VARS) as InstanceFeature[]).map((f) => [VARS[f], features[f] ? "true" : "false"]),
  ) as Record<(typeof VARS)[InstanceFeature], string>;
}
