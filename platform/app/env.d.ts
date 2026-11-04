// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Secrets (set with `wrangler secret put`, so not in the generated types).
interface PlatformEnv {
  EMAIL_API_KEY?: string; // the email provider's API key, for operator alerts (open-source plan 3.1)
  EMAIL_WEBHOOK_SECRET?: string; // the Bearer token the provider's bounce and complaint webhooks send
  // Their old names, read until every instance has the new ones (docs/operating.md).
  PLUNK_SECRET_KEY?: string;
  PLUNK_WEBHOOK_SECRET?: string;
  DISCORD_WEBHOOK_URL?: string; // the operator's Discord notifications (issues #32, #79)
  OPERATOR_EMAIL?: string; // where operator alerts go
  TURNSTILE_SECRET?: string; // the sign-up form's Turnstile check (issue #73)
  MAIL_ALLOWLIST?: string; // staging only: who may get mail (a secret, so never committed)
  MAIL_RESTRICTED?: string; // "true" on staging (a var from config mail.restricted)
}
