# Contributing to Theme Camp App

Thanks for helping. Theme Camp App holds camps' member lists, contact details and dues, so a few parts of it get extra care. This guide covers how to set up, how the tests work, how the code is written, and what makes a pull request easy to merge.

Questions are welcome in the issues, or in #dev on the [Discord server](https://discord.gg/R49HBkM8u). Bug reports and feature ideas go in issues. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as in [SECURITY.md](SECURITY.md), never in a public issue.

## Set up

You need Node 22, Docker and Git.

```sh
docker run -d --name tca-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test -p 54339:5432 postgres:18-alpine
npm ci
npm run check        # typecheck, lint and the full test suite, about a minute
```

`npm run dev` runs the camp Worker and `npm run dev:platform` the platform Worker, both from `config/local.json`. [`docs/architecture.md`](docs/architecture.md) is the map: the two Workers, how a request finds its camp, row-level security, roles, email, jobs and data rights. Read it before a change of any size.

## How the tests work

- **A real Postgres, never a live database.** Each test file gets its own throwaway database, migrated from `drizzle/` and seeded with one test camp (`tests/helpers/db.ts`, `tests/helpers/seed.ts`). Point `TEST_DATABASE_URL` elsewhere to use another server.
- **The built Workers, in workerd.** Request tests build both Workers once per run and send them real requests through Miniflare (`tests/helpers/worker.ts`, `tests/helpers/platform.ts`), as the camp's own role, under row-level security. Email, Turnstile and Discord are stubbed at their URLs, and anything else outbound fails.
- **Guards that fail on purpose:**
  - every route must be listed as public or sit under the signed-in layout (`tests/authz/routes.test.ts`);
  - every route needs a cross-camp probe that aims camp A's Admin at camp B's records (`tests/authz/cross-camp.registry.ts`);
  - no camp's own name or wording is built into the app (`tests/tenancy/no-camp-strings.test.ts`);
  - the database grants and row-level security must check out after every migration (`tests/db/`).

  A new route or table will trip one of these until you decide, in the test, what it is.
- CI runs the suite in three shards on PostgreSQL 18, the Postmark email tests, and the database and isolation tests on PostgreSQL 16, 17 and 18.

## How the code is written

- **Match what's there.** Read the file and its neighbours first, and write like them. Biome formats and lints (`npm run lint`; `npx biome check --write <files>` fixes formatting).
- **Comments say why**, not what. Plenty of them cite a requirement (`R39`) or a plan unit (`U15`). [`docs/architecture.md`](docs/architecture.md), under "Reading the code comments", says where those come from.
- **Plain words** in the interface, emails and docs: short sentences, the camp's own vocabulary (Leads, dues, the burn), no jargon. Error messages say what to do next.
- **Camp data always goes through the camp's scoped client** (`app/lib/tenancy.server.ts`), never around it. Cross-camp reads exist only as the few `SECURITY DEFINER` functions listed in `scripts/db-grants.ts`.
- **Migrations:** change `app/db/schema.ts`, run `npx drizzle-kit generate --name <what>`, and read the SQL it writes. Migrations are forward-only and never edited once merged. A new table with a `camp_id` needs row-level security (`select enable_camp_rls('<table>')` in the migration), or the grants check fails.
- **License headers:** every source file starts with these two lines (after any `#!` line; `#` in shell scripts, `/* */` in CSS), and a test fails without them:

  ```ts
  // SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
  // SPDX-License-Identifier: AGPL-3.0-or-later
  ```
- **Instance settings** go in `config/schema.ts` and every `config/*.json`, never hard-coded. Secrets never go in the repository.

## Sign off your commits (DCO)

Every commit carries a [Developer Certificate of Origin](https://developercertificate.org/) sign-off: a line saying you wrote the change, or otherwise have the right to submit it under the project's license. `git commit -s` adds it:

```
Signed-off-by: Your Name <you@example.com>
```

A check on each pull request looks for it. To fix earlier commits on your branch: `git rebase --signoff main`, then force-push the branch.

## A good pull request

- **One change.** A fix and an unrelated tidy-up are two pull requests.
- **Tests** that would fail without the change. For a bug, the test that reproduces it.
- **Screenshots** for anything people see, at phone width (390 px) and desktop (1100 px).
- **A line in `CHANGELOG.md`** under Unreleased, for anything people or operators would notice. Add the migration under Migrations, and anything an operator must do by hand (a new secret, a config field, a one-off command) under Upgrade notes.
- `npm run check` passes.

For a big change, open an issue first so we can agree on the approach before you build it.

## Areas that need extra care

Changes here get a closer review from the maintainer, and should come with tests that show the boundary holds:

- **Camp isolation:** `app/lib/tenancy.server.ts`, `app/lib/db.server.ts`, `drizzle/`, `scripts/db-roles.ts` and `scripts/db-grants.ts`, and the RLS and isolation tests;
- **Sign-in and access:** `app/lib/auth*.ts` and `app/lib/access.server.ts`;
- **Data rights and deletion:** `platform/` (the console, data requests, webhooks) and `app/lib/leave-camp.server.ts`;
- **The hosted service's own settings:** `.github/`, `config/` and `legal/`.

## Where to start

Issues labelled `good first issue` are small and point at the files involved. `help wanted` issues are bigger. If you want to take one on, say so in the issue so nobody duplicates the work.
