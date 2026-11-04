# Theme Camp App

Planning for Burning Man theme camps, in one place the whole camp can use:
- **People and invites:** everyone in one list, invited by email, with no passwords.
- **RSVPs and arrival:** who's coming, when they arrive, what they're bringing.
- **Stewards Sale requests:** ticket and vehicle pass requests, which the camp's leads lock and send on.
- **Dues:** the Treasurer records who's paid. The app never takes payments.
- **Jobs:** volunteer jobs and elected ones.
- **Setup Access Passes.**
- **Newcomer inquiries.**
- **Guides.**
- **A Yearbook and directory.**

Each camp gets its own address and can only ever see its own data.

> This app is not affiliated, endorsed, or verified by Burning Man Project.

## Use it

The hosted service, **[themecamp.app](https://themecamp.app)**, is free for camps. Look around the **[demo camp](https://demo.themecamp.app)** (made-up people; nothing you change is saved), or ask to join the pilot from the site. It's run by Kline Technology LLC.

## Run it yourself

Theme Camp App runs on Cloudflare Workers with a Postgres database and an email provider. You can run your own copy for one camp or many. [`docs/self-hosting.md`](docs/self-hosting.md) takes you from a fork to a running instance, and [`docs/operating.md`](docs/operating.md) covers running it.

## Work on it

```sh
docker run -d --name tca-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test -p 54339:5432 postgres:18-alpine
npm ci
npm run check        # typecheck, lint, tests
npm run dev          # the camp Worker
npm run dev:platform # the platform Worker
```

Tests never touch a hosted database: each test file gets its own throwaway Postgres database, and request tests run the built Workers in workerd.

- **How it works:** `docs/architecture.md`
- **How to run an instance:** `docs/operating.md`
- **Why it is the way it is:**
  - the requirements: `docs/brainstorms/2026-09-28-multi-camp-platform-requirements.md`;
  - the plans in `docs/plans/`;
  - the decisions in `docs/decisions/`.
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md). Every commit carries a [DCO](https://developercertificate.org/) sign-off (`git commit -s`). Report security problems privately: [`SECURITY.md`](SECURITY.md).

## Layout

- **`app/`, `workers/`:** the **camp Worker** (React Router 8 on Cloudflare Workers), serving every camp.
- **`platform/`:** the **platform Worker**: the public site, the operator console, webhooks and scheduled jobs.
- **`config/`:** each instance's settings (no secrets). The Workers' `wrangler.jsonc` files are generated from them: `npm run config:local`.
- **`app/db/`, `drizzle/`:** the Drizzle schema and migrations (Postgres through Hyperdrive).
- **`content/`:** the admin guide and the starter guides camps copy from.
- **`legal/`:** the legal pages: `legal/hosted/` is the hosted service's own; `legal/templates/` are examples for self-hosters.
- **`tests/`:** Vitest.

## License and name

The code is licensed under the **AGPL-3.0-or-later** ([`LICENSE`](LICENSE)). Anyone may use, change and self-host it; anyone who offers a modified version over a network must share their changes. Copyright Curtis Kline and contributors.

"Theme Camp App" and its icon refer to the hosted service at themecamp.app. If you run your own copy, give it its own name and icon. `TRADEMARKS.md` explains what's fine.
