// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Secrets aren't in the generated wrangler.jsonc, so `wrangler types` can't see them. Declared here.
interface AppSecrets {
  BETTER_AUTH_SECRET: string;
  EMAIL_API_KEY?: string; // the email provider's API key (open-source plan 3.1)
  PLUNK_SECRET_KEY?: string; // its old name, read until every instance has EMAIL_API_KEY
  TURNSTILE_SECRET: string;
  DISCORD_WEBHOOK_URL?: string; // the operator's Discord notifications (issues #32, #79); optional
  MAIL_ALLOWLIST?: string; // staging only: who may get mail (a secret, so never committed)
  MAIL_RESTRICTED?: string; // "true" on staging (a var from config mail.restricted)
}

interface Env extends AppSecrets {}

declare namespace Cloudflare {
  interface Env extends AppSecrets {}
}
