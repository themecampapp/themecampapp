// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The platform Worker's env, for tests that call platform modules directly. The platform's
// own is generated (platform/worker-configuration.d.ts) and can't be loaded next to the camp
// Worker's runtime types, so this mirrors it; the platform build typechecks the real one.
interface PlatformEnv {
  FILES: R2Bucket;
  HYPERDRIVE_PLATFORM: Hyperdrive;
  PLATFORM_DOMAIN: string;
  ALERT_MAIL_FROM: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  CONSOLE?: string;
  ICON_DIR?: string;
  SIGNUP_PAGE?: string;
  FEEDBACK?: string;
  USAGE_COUNTS?: string;
  DISCORD?: string;
  SINGLE_CAMP_SLUG?: string;
  SINGLE_CAMP_HOST?: string;
  MAIL_ALLOWLIST?: string;
  MAIL_RESTRICTED?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_WEBHOOK_SECRET?: string;
  PLUNK_WEBHOOK_SECRET?: string;
  PLUNK_SECRET_KEY?: string;
  OPERATOR_EMAIL?: string;
  CONTACT_EMAIL?: string;
  PRODUCT_NAME: string;
  OPERATOR_NAME?: string;
  SUPPORT_URL?: string;
  SOURCE_URL?: string;
  RESERVED_SLUGS?: string;
  RESERVED_PARTS?: string;
  LEGAL_DIR?: string;
  PILOT_AGREEMENT?: string;
  DISCORD_WEBHOOK_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  SIGNUP_LIMITER?: RateLimit;
}
