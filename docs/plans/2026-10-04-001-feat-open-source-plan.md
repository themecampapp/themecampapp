---
title: "feat: Open-source Theme Camp App, self-hostable, with the hosted service kept free"
type: feat
status: draft
date: 2026-10-04
revised: 2026-10-05 (one codebase and one repository; no separate ops repo, no single-camp-only version); 2026-10-11 (Phase 1b: move from Wrangler to the cf CLI before Phase 2; spike: no-go until React Router supports the Vite plugin 2.0 build output); 2026-10-11 (Phase 0: decisions recorded, ownership and trademark drafts, legal packet prepared)
reviewed: 2026-10-05, outside review in docs/plans/2026-10-05-001-review-open-source-plan.md; agreed findings folded in
---

# Open-source Theme Camp App

## Problem frame

Theme Camp App is a private repository that runs one hosted service (themecamp.app) on the operator's own Cloudflare, Neon and Plunk accounts. Several theme camp organizers who write software would like to help build it, and some would like to run it on their own infrastructure. Most organizers just want something that works, so the free hosted version stays the main way camps use it.

The goal is to make the code public and genuinely usable by others, without weakening the hosted service, the privacy of the camps on it, or the operator's control of production:

- **Contributors** can clone the repo, run it and its tests locally, and send pull requests that are reviewed and merged with the safeguards the code already relies on (camp isolation, roles, data deletion).
- **Self-hosters** can stand up their own instance, for one camp or many, on their own accounts, from documentation and a setup script, and upgrade it safely.
- **The hosted service** keeps running from the same code in the same repository, deployed from it with its secrets kept in protected GitHub environments, and keeps being free.

This plan does all of it: no "publish now, make it self-hostable someday" halfway step. And it keeps **one codebase in one repository**: no separate single-camp edition and no private second repository to keep in step (see "One codebase, one repository" below). It's sequenced so the repository only goes public once it's clean, documented and safe to contribute to.

## Where things stand (checked 2026-10-04)

- **No secrets in the git history.** A scan for key, token, webhook and connection-string patterns found only test placeholders. Secrets live in Worker secrets and GitHub environments; `.gitignore` covers keys, `.dev.vars`, dumps, `.age` files and spreadsheets.
- **No member data in the repo.** Import tests use synthetic people (`tests/import/fixture.ts`, `history-fixture.ts`).
- **CI is fork-safe.** Jobs that use secrets (`deploy-staging`, `deploy-production`, `backup`, `isolation-probe`) run only on `main` or on schedules, inside the `staging` and `production` GitHub environments. Pull-request jobs use no secrets.
- **Dependencies' licenses are compatible with AGPL-3.0 and Apache-2.0**: mostly MIT, ISC, Apache-2.0 and BSD, with a few MPL-2.0 and one LGPL-3.0, none restrictive.
- **Origin of the code:** it started as a copy of the Yellow Balloon camp app (`docs/fork.md`), which was written for YB by the same author. Ownership needs confirming in writing before licensing (Unit 0.2).
- **What ties the code to the hosted service today:**
  - **Configuration:** both `wrangler.jsonc` files hard-code Worker names, domains (`themecamp.app`, `themecamp.dev`), Hyperdrive IDs, R2 bucket names, Turnstile site keys, the Cloudflare Access team and AUDs, rate-limit namespaces and crons. `scripts/check-deploy-target.ts` hard-codes Worker names and zones.
  - **Domains in code:** `app/lib/camp.ts` (`legalBase` fallback), `app/lib/hosts.ts`, `app/lib/reserved-slugs.ts` and `.github/workflows/ci.yml`.
  - **Email:** Plunk is called directly from `app/lib/mail.server.ts` and `platform/app/lib/mail.server.ts`, with bounce and complaint webhooks in `platform/app/webhooks/plunk.server.ts`. About a dozen modules carry a `PLUNK_SECRET_KEY` type.
  - **Neon:** `scripts/neon-snapshot.sh` (the pre-migration branch in the production deploy) and `scripts/restore-drill.sh`. The database itself is plain Postgres through Hyperdrive.
  - **Cloudflare Access** guards the operator console. Creating a camp needs the console (`platform/app/routes/ops.camps.new.tsx`) or the sign-up queue.
  - **Branding:** "Theme Camp App" appears 116 times across 43 files: emails, footers, the public site, legal pages, the guide and the favicon.
  - **Legal:** `content/legal/*` are Kline Technology LLC's Terms, Privacy Policy, data-handling page and pilot agreement.
- **Hosted- and YB-specific material that shouldn't be public as is:**
  - YB-only code: `scripts/import-2026/`, `scripts/import-history/`, `scripts/yb-guides/`, `scripts/yb-redirect/`, `scripts/migrate-yb.ts` and `tests/migrate-yb/`.
  - YB documents: `docs/cutover-yb.md` and `docs/plans/2026-10-01-001-feat-yb-cutover-plan.md`.
  - The runbook, which is half general architecture and half the hosted service's operations: account and project IDs, the secrets inventory, the restore commands.
  - `docs/reviews/` and `docs/plans/2026-09-30-security-and-ux.md` (the operator's own files). These were never committed: they exist only as untracked files in the operator's working copy, so a snapshot taken from git (D6) won't include them. Move them out of the working copy before Phase 8 so a stray `git add -A` can't publish them.
  - The staging mail allowlist, `MAIL_ALLOWLIST` in both `wrangler.jsonc` files, which lists the operator's personal email addresses (Unit 2.1).
  - About 290 code comments citing the private planning documents' numbers (`R74`, `U15`, `issue #73`…), which need their documents published or explained (Unit 1.2).
  - `docs/fork.md`.
- **Burning Man's API terms** (innovate.burningman.org) apply once Theme Camp App uses the API:
  - apps must be free, with no commercial promotion;
  - keys can't be disclosed or transferred;
  - the exact disclaimer must appear prominently (done, PR #108);
  - the data must be destroyed if access ends.

## Decisions to make before Phase 1

Each has a recommendation; Phase 0 records the choice in `docs/decisions/`.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **License** | **AGPL-3.0-or-later** | Anyone may use, change and self-host it. Anyone who offers a modified version to others over a network must share their changes, which keeps improvements flowing back and stops a closed hosted copy. The hosted service is unaffected: its source is the public repo. Apache-2.0 is the alternative if wider adoption by companies matters more than reciprocity. |
| D2 | **Contributions** | **DCO** (a `Signed-off-by:` line on each commit, checked by a GitHub app). **Decided 2026-10-10:** DCO. Everything stays open under AGPL and the hosted service stays free, so there's nothing a CLA would be needed for. | Light for contributors. A **CLA** is only needed if the code might later be relicensed or offered under a commercial license. Decide now: it can't be added retroactively for code already contributed. |
| D3 | **Copyright holder** | Curtis Kline, personally, for existing code (revised 2026-10-16 from Kline Technology LLC); contributors keep their own copyright under the DCO | No assignment needed. Kline Technology LLC runs the hosted service under the AGPL like anyone else. |
| D4 | **Name and marks** | Keep **"Theme Camp App"** and the TCA icon for the hosted service, with a short trademark policy: forks and self-hosted instances use their own name and icon, or "based on Theme Camp App" | Prevents self-hosted instances being mistaken for the hosted service, which matters because of the data it holds. Needs the product name to be configurable (Unit 3.5). |
| D5 | **Repository topology** | **One public repository** (new GitHub organization `github.com/themecampapp/themecampapp`, decided 2026-10-11) holds the code *and* the hosted service's configuration, legal pages and deploy workflows. Secrets stay in its protected `staging` and `production` GitHub environments. | One place to change, review, test and deploy. The hosted settings are identifiers, not credentials (see "One codebase, one repository"), and the legal pages are already public on themecamp.app. |
| D6 | **History** | **Start the public repository from a fresh, clean snapshot**; archive this repository (private, read-only) as the record of how it got here | Simpler and safer than rewriting history. The history holds YB material and personal notes that serve no one publicly. After the switch, the public repository is the only one anyone works in. |
| D7 | **Runtime** | **Cloudflare Workers stays required** (Workers, R2, Images, Hyperdrive, Turnstile, rate limiting) | The architecture depends on it, and a Cloudflare account is free or $5 a month. A Node/Docker runtime would be a separate project (see Scope boundaries). |
| D8 | **Email providers** | Ship **Plunk** and **Postmark** behind an adapter; document how to add others | Two real implementations prove the adapter. Postmark has an HTTP API that works from Workers, bounce and complaint webhooks, and a free tier. |
| D9 | **Releases** | **Semantic versioning** with tags, a `CHANGELOG.md` and upgrade notes; the hosted service deploys tagged releases | Self-hosters need to know what changed and whether a migration needs care. |
| D10 | **Editions** | **One edition.** Single-camp is a configuration of the same code, not a separate or reduced version. Nothing (not even the operator console in `platform/`) is held back. | A single camp is already the multi-camp app with one camp in it. Stripping multi-camp support, or keeping `platform/` private, would fork the code: every fix twice, and contributors' work not reaching the hosted service. `platform/` also runs the jobs and data deletion every installation needs. AGPL (D1) already stops a closed hosted copy. |

## One codebase, one repository

The operator's constraint: no split codebase, for maintainability. This shapes two choices.

**No single-camp-only version (D10).** Every table has a `camp_id`, row-level security keeps each camp's rows apart, and every request is routed to its camp by its address. A single camp is simply that app with one camp in it. Unit 3.4 adds a **single-camp mode**: one setting serves one camp at one host and makes the operator console optional. It's the same code and the same tests, just configured differently. Removing multi-camp support for a separate single-camp release would create the second codebase this plan avoids.

**No private second repository (D5).** What the hosted service needs beyond the code isn't secret:

| What | Where it lives | Why that's fine |
|---|---|---|
| Hosted settings: domains, Worker names, Hyperdrive and R2 IDs, Turnstile site keys, Access team and AUD, crons | `config/hosted.json`, `config/staging.json`, committed | Identifiers. Using any of them needs the Cloudflare and Neon tokens, which are secrets. Turnstile site keys and the Access AUD are designed to be public. |
| Secrets: API tokens, database URLs, Worker secrets, the backup public key | GitHub environments `staging` and `production`, and Worker secrets | Never in the repo. Workflows from forks and pull requests get none of them. |
| Deploy, backup and isolation-probe workflows | `.github/workflows/`, committed | Production runs only from tags on the canonical repo, through an environment that requires the operator's approval for every run. |
| Hosted legal pages (Kline Technology LLC's Terms, Privacy Policy, data handling, pilot agreement) | `legal/hosted/`, committed | Already published on themecamp.app. Self-hosters get templates in `legal/templates/` (Unit 3.6). |
| Hosted operations: how to deploy, restore, run data requests, handle incidents | `docs/operating.md`, committed | Useful to self-hosters too. Written without credentials or personal contact details. |
| Personal notes, reviews, account-level details (who owns which account, recovery contacts) | Outside the repository (a private notes folder or wiki) | Not code, so keeping them elsewhere splits nothing. |

## Requirements

- **R1.** The public repository contains no secrets or credentials, no member or camp data, and no personal notes or contact details. Hosted configuration identifiers are allowed (see "One codebase, one repository"). Its history starts from a single clean commit.
- **R2.** It's licensed (D1), with a contribution process (D2) and a trademark policy (D4).
- **R3.** A contributor can go from clone to passing tests in under 15 minutes with only Docker and Node, without any account, on a middling laptop, not a fast development machine (that's who R3 is for; the acceptance test uses one).
- **R4.** A self-hoster can deploy a working instance on their own Cloudflare, Postgres and email accounts from the docs and a setup script. That includes a **single-camp** instance with no operator console, and a **multi-camp** instance with one.
- **R5.** Nothing about the hosted service is hard-coded: domains, Worker names, resource IDs, product name, operator name, legal pages, support links and the email provider all come from configuration.
- **R6.** The hosted service keeps running unchanged for its camps throughout, deployed from the same repository as everyone else's code, with no private copy of the code anywhere.
- **R7.** Changes to security-critical code (row-level security, grants, auth, sessions, tenancy, data deletion, the operator console) and to the deploy workflows and hosted config need the maintainer's review. Production deploys need the operator's approval, and production stays reachable only by the operator.
- **R8.** Security issues are reported privately, fixed and deployed to the hosted service before they're disclosed.
- **R9.** Self-hosters can upgrade from one release to the next by following release notes. Migrations stay forward-only and run in order, as today.
- **R10.** The privacy and legal position is clear: the hosted service's Terms and Privacy Policy cover only the hosted service. A self-hosted instance's operator is the data controller and supplies their own.

## Scope boundaries

- **Not in this plan:**
  - running outside Cloudflare Workers (a Node or Docker server);
  - a managed one-click deploy button for other clouds;
  - paid tiers.
  
  The configuration work here (Phase 2) and the email adapter (Unit 3.1) are the steps any later runtime port would need, so nothing here blocks one.
- **No federation between instances**, and no moving a camp between instances beyond the existing full export.
- **The demo camp stays a hosted feature.** Self-hosters can seed their own demo with `scripts/seed-demo.ts` if they want one, but it isn't part of setup.
- **Existing data isn't migrated or renamed.** The hosted service keeps its Workers, database, buckets and domains as they are.

## How the pieces fit after this work

```
github.com/themecampapp/themecampapp  (public, AGPL — the only repository)
├── app/, platform/, workers/      one codebase: multi-camp, or single-camp by configuration
├── drizzle/                       migrations
├── config/
│   ├── example.json               documented template for self-hosters
│   ├── local.json                 dev and tests
│   ├── hosted.json, staging.json  the hosted service's settings (identifiers only)
├── legal/
│   ├── templates/                 for self-hosters to adapt
│   └── hosted/                    Kline Technology LLC's Terms, Privacy Policy, pilot agreement
├── scripts/setup.ts               self-hosting setup
├── docs/                          architecture, self-hosting, upgrading, operating, security
└── .github/workflows/
    ├── ci.yml                     every push and pull request: no secrets
    ├── deploy-staging.yml         main → staging       (environment "staging")
    ├── deploy-production.yml      tag v* → production   (environment "production",
    └── backup.yml, isolation-probe.yml                    operator approval required)

Secrets: only in the GitHub environments and Worker secrets. Forks and pull requests get none.
Self-hosters: fork or clone, add config/<theirs>.json and their own secrets and environments.
```

Configuration flows one way. `config/<instance>.json` holds the non-secret settings: domains, names, resource IDs, the product and operator names, links and features of the instance. A generator turns it into the two `wrangler.jsonc` files at build time. Secrets stay in Worker secrets and the GitHub environments.

## Implementation units

Effort is in focused working days for one developer. The total is about **8–10 weeks elapsed** (the outside review's estimate, which this plan agrees with: Phase 2 and especially Phase 3 hold several multi-day items each), and the phases are mostly sequential. Phases 3 and 5 can overlap once Phase 2 is done.

**Flex scope, declared up front:** if Phase 3 runs long, the **Postmark adapter** (D8's second provider) is the first thing to move, to a fast-follow release before v1.1. It stays in this plan's scope; it just isn't allowed to hold up 1.0. One real provider behind a documented adapter interface still ships the design. The product-name sweep (3.5) and the legal split (3.6) must not slip instead: the self-hosting guide, the trademark position and R4's acceptance test depend on them.

### Phase 0: Decisions and legal groundwork (2–3 days, mostly the operator's)

- [x] **0.1 Record the decisions** (D1–D10) in `docs/decisions/0001-open-source.md`, one short section each: the choice and why. *(Done 2026-10-11: the operator accepted D1–D10 as recommended, with the organization `themecampapp`.)* Include the two decided after the review:
  - **Scheduled jobs in a single-camp instance run on the platform Worker, serving nothing public** (Unit 3.4). Its hourly cron and job registry already exist and are tested. A shared job runner would be a third build target and a second code path, which D10 exists to avoid.
  - **The requirements document and the pilot plan are published, redacted** (Unit 1.2), so the code comments citing their numbers keep making sense.
- [x] **0.2 Confirm ownership of the code.** Note in writing that the Yellow Balloon app's code (the fork source) was written by the operator and can be relicensed by Kline Technology LLC. Confirm no third-party code was copied in without its license, and do a quick review of anything vendored. *(Done 2026-10-11, `docs/decisions/0002-code-ownership.md`: no third-party code; the operator wrote all of it, guides included. The written assignment to the company, if needed, comes from the lawyer in 0.4.)*
- [ ] **0.3 Trademark policy.** A short `TRADEMARKS.md`: what "Theme Camp App" and the TCA icon refer to, and how forks and self-hosted instances may describe themselves. *(Drafted 2026-10-11; final after the lawyer's review.)*
- [ ] **0.4 Legal review.** This was already on the deferred list. The lawyer reviews:
  - the hosted Terms and Privacy Policy, now that the code is public;
  - the license choice and DCO;
  - the trademark policy;
  - wording that makes clear self-hosted instances aren't the hosted service;
  - Burning Man's API terms against publishing the code, plus the data addendum the ticket and SAP data will need.

  Do this in parallel with Phases 1–2; it must finish before Phase 8. *(Revised 2026-10-16: the operator deferred the review until after publication, so it no longer blocks Phase 8. Two questions that would have changed what's published are settled without it: Burning Man's API terms don't prohibit publishing integration code, and other integrations with the API publish theirs; and the copyright stays with Curtis Kline personally (D3, revised), so no assignment is needed. The hosted Terms and Privacy Policy, the trademark policy and the wording about self-hosted instances follow the review.)* *(A packet with the documents and questions was prepared 2026-10-11 and kept out of the repository, since it covers the operator's discussions with Burning Man. The operator sends it.)*

### Phase 1: Clean-up and the public/private split (3–4 days)

- [x] **1.1 Remove Yellow Balloon-only code and docs** from the tree that will be published *(done 2026-10-11; also removed `scripts/import-env.ts`, used only by the import scripts, and the four `import:`/`history:` npm scripts)*:
  - **Code:** `scripts/import-2026/`, `scripts/import-history/`, `scripts/yb-guides/`, `scripts/yb-redirect/`, `scripts/migrate-yb.ts`, `tests/migrate-yb/`, and the YB comment in `app/db/schema.ts`.
  - **Tests that depend on those scripts:**
    - delete `tests/import/apply.test.ts`, `tests/import/history.test.ts`, `tests/import/fixture.ts` and `tests/import/history-fixture.ts`, which only test the YB import scripts;
    - `tests/volunteer/volunteer.test.ts` and `tests/people/export.test.ts` borrow a CSV-reading helper (`parseCsvWith`) from `scripts/import-2026/decisions.ts`. Switch them to the app's own parser in `app/lib/csv.ts`, adding a small test helper if needed, before the script goes;
    - keep `tests/import/normalize.test.ts` and `tests/import/csv-import.test.ts`, which test code that stays (`app/lib/import/normalize.ts`, `app/lib/data/csv-import.server.ts`).
  - **Docs:** `docs/cutover-yb.md`, `docs/plans/2026-10-01-001-feat-yb-cutover-plan.md` and `docs/fork.md`.
  - The archived repository (D6) keeps them.
  - *Verification:* `npm run check` passes, and the "no camp wording" guard still passes.
- [x] **1.2 Publish the planning documents, redacted.** *(Done 2026-10-11: the operator's name and account details replaced across `docs/`; `docs/architecture.md` has the "Reading the code comments" section, with the issue table to fill in at Unit 8.2.)* The requirements doc, the pilot plan and the Lead workspace plan describe *why* the system is the way it is, which is valuable to contributors. About 290 code comments cite their numbers (`R74` 15 times, `R65` and `R39` 12 times each, `U15`…) and GitHub issue numbers. So these documents are published with account IDs and personal details removed, using Unit 1.3's checks, and the R and U numbers keep their meaning. Rewriting the comments isn't worth the churn.
  - `docs/architecture.md` (Unit 5.4) gets a short "Reading the code comments" section: what R and U numbers refer to, and an old-to-new list for the GitHub issues the code cites (Unit 8.2).
  - The YB cutover plan stays out (Unit 1.1). `docs/reviews/` and `docs/plans/2026-09-30-security-and-ux.md` were never committed and stay the operator's own (see "Where things stand"). *(2026-11-04: `docs/reviews/` was committed by mistake in #152 and removed again before publication. The snapshot is taken from HEAD alone, so it isn't published.)*
- [x] **1.3 Rework the runbook.** *(Done 2026-10-11: `docs/runbook.md` became `docs/architecture.md` and `docs/operating.md`; the account-level details and Yellow Balloon specifics went to the operator's private notes, outside the repository. The staging allowlist and the Access team domain are still in the `wrangler.jsonc` files until Phase 2.)*
  - How the system works (tenancy, row-level security, roles, email, files, jobs, alerts, support access, data requests) goes into `docs/architecture.md` (Unit 5.4).
  - How to operate an instance (deploys, backups and restore drills, data requests, incidents, alerts) becomes `docs/operating.md`, written for any operator, with the hosted service's specifics as examples and settings in `config/hosted.json`.
  - Account-level and personal details move out of the repository to the operator's private notes: who owns which account, recovery contacts, the operator's email, the secrets inventory's owners, and the Neon project and organization IDs used by hand.
  - *Verification:* `git grep` finds no personal emails, no `rr0`, no Neon organization or project IDs outside `config/`, and nothing secret-looking in the tree (gitleaks, Unit 7.2).
- [x] **1.4 Strip personal details from scripts:** the Neon project ID in `scripts/restore-drill.sh` comments (it comes from the environment instead), and `check-deploy-target.ts`'s hard-coded names (replaced in Unit 2.3). *(Done 2026-10-11 for the project ID. The Worker names in `check-deploy-target.ts` aren't personal and move to config in 2.3. The staging `MAIL_ALLOWLIST` in both `wrangler.jsonc` files moves to a staging secret in 2.1: the secret must be set before the variable is removed.)*
- [x] **1.5 Rewrite `README.md`** for the public *(done 2026-10-11, except the screenshot, which waits for a final look; `docs/self-hosting.md` and `CONTRIBUTING.md` are linked as on their way)*: what it is, a screenshot, the hosted service link, "run it yourself" (link to Unit 4.1), "contribute" (link to Unit 5.1), the license and the trademark note. It keeps the exact Burning Man disclaimer (`app/lib/disclaimer.ts`).

### Phase 1b: Move from Wrangler to the `cf` CLI (spike ½–1 day, then 2–4 days)

Cloudflare's new CLI, `cf` (https://developers.cloudflare.com/cf/wrangler/migrate/), replaces `wrangler.jsonc` with a typed `cloudflare.config.ts`. That changes Phase 2:
- the config can import `config/<instance>.json` directly, picked by `--mode`;
- so Unit 2.2's generator script and its gitignored generated files aren't needed;
- `cf deploy --prebuilt` deploys exactly the build CI tested.

Doing this first avoids building the generator and then throwing it away. It's independent of Phases 0–1, which can run alongside.

**Status: deferred until after publication** (2026-10-16; see the spike result). `cf` is in **beta**. Its docs warn that "Commands, configuration, and Build Output can change before the stable release." That's why this phase starts with a spike that ends in a go/no-go.

**Caution:** don't run `cf dev`, `cf build` or `cf deploy` in the repo before `cf migrate`. In a project using the Vite plugin, they auto-configure a single-page app and rewrite `package.json`, the deploy script and `vite.config.ts`, without asking when run in CI.

- [ ] **1b.1 Spike** (½–1 day, on a branch). Run `cf migrate --dry-run`, then `cf migrate`, for the camp app (root) and `platform/`. Check:
  - **React Router with the Cloudflare Vite plugin 2.0 beta,** which `cf` builds with. We're on `@cloudflare/vite-plugin` 1.60. The docs say only Vite and Astro accept `--mode` when `cf` runs a framework's build command, and ours runs through `react-router build`.
  - **Every binding converts:** Hyperdrive, R2, Images, rate limiting, placement by region, routes with a zone, crons, observability, `workers_dev` and `preview_urls`, vars, secrets, and the staging environment as a mode.
  - **Two configs in one repo,** with generated types that don't clash (`Env` and `PlatformEnv`).
  - **The new build output** (`.cloudflare/output/v0/`) works with:
    - the test harness (`tests/helpers/worker.ts` runs the built bundle in workerd);
    - `scripts/check-deploy-target.ts`, which reads `build/server/wrangler.json` today.
  - **A staging deploy with `cf`,** and a smoke check.
  - **The gaps:** `wrangler tail` and `wrangler secret put` still need Wrangler. Keep it as a dev dependency for those two (`npx wrangler tail <name>`, `npx wrangler secret put <name> --name <worker>`).

  **Go/no-go:** go if both apps build, the full test suite passes against the new output, and staging deploys and works. No-go if React Router can't build on plugin 2.0, or a binding can't be expressed. Record the findings under this unit.

  **Spike result (2026-10-11): no-go for now.** Tested with `cf` 1.0.0-beta.14, `@cloudflare/vite-plugin` 2.0.0-beta (the `beta` tag resolved to `2.0.0-beta.sha-91c870c02`) and `@react-router/dev` 8.4.0, the latest release.
  - **The config converts cleanly.** `cf migrate` turned the camp app's `wrangler.jsonc` into `cloudflare.config.ts` with no required items: every binding (Hyperdrive, R2, Images, rate limiting, targeted placement, routes with zone, crons, observability, `workersDev` and `previewUrls`, vars) and staging as a mode. Its only notes were source maps (move to `build.sourcemap`) and modes.
  - **The build fails.** The plugin beta forces the client build into `.cloudflare/output/v0/workers/default/assets` (`forceBuildOutputDirs`, run unconditionally in `configResolved`, overriding any `build.outDir`). React Router 8.4 hard-codes its client directory as `<buildDirectory>/client` and reads `build/client/.vite/manifest.json`, so the server build stops with ENOENT. The manifest is written, just not where React Router looks.
    - A symlink from `build/client` to the assets directory doesn't help: React Router empties `build/` at the start of the build.
    - The plugin's README lists React Router v8 support, so this presumably needs a React Router release that knows about the build output location. None has shipped as of 8.4.0.
  - **Not tried,** since the camp app was already blocked: `platform/`, the test harness on the new output, and a staging deploy.
  - **Try again when** a `@react-router/dev` release (or its changelog) mentions the Cloudflare Vite plugin 2.0 or Build Output, or the plugin 2.0 goes stable. Pin exact versions when retrying, not the `beta` tag. The steps above still apply.
  - **Rechecked 2026-10-16: still blocked. Deferred until after publication** (the operator's decision). `@cloudflare/vite-plugin` `2.0.0-beta.v.1`, published that morning, still forces the client build into `.cloudflare/output/v0/…/assets` in `configResolved`, and `@react-router/dev` is still 8.4.0. Nothing blocks on 1b: Unit 2.2's generator does the job, and instances' settings stay in `config/<instance>.json`, which a later `cloudflare.config.ts` can import. Moving after 1.0 changes our tooling and docs, not instances' config, so it's an upgrade note rather than a breaking change.
    - **Already tried:** `cloudflare({ viteEnvironment: { name: "ssr" } })`, the usual advice for React Router with this plugin. Both `vite.config.ts` files have always set it. It names the environment the Worker builds from; it doesn't touch the client environment's output directory, which `forceBuildOutputDirs` overrides regardless.
  - **Meanwhile:** follow "If no-go" below. `cf` can still be used for account and resource commands without migrating, since those don't read the project config.
- [ ] **1b.2 Migrate** (2–4 days, if go):
  - `cloudflare.config.ts` for the camp app and the platform, with staging and production as modes (`--mode staging` / `--mode production`);
  - build settings, such as source maps, moved to `vite.config.ts`;
  - `.cloudflare/` added to `.gitignore`;
  - `tsconfig` includes `.cloudflare/types`;
  - `typegen` and `postinstall` replaced by `cf`'s type generation;
  - the test harness and `check-deploy-target.ts` reading the new output;
  - `scripts/seed-demo.ts`'s R2 upload moved to `cf`;
  - `ci.yml` and `deploy-production.yml` build once and deploy with `cf deploy --prebuilt --mode <mode>`, authenticated with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`;
  - `docs/runbook.md` updated: deploy, tail, secrets.

  The `wrangler.jsonc` files are deleted once deploys, scripts and CI all use `cf`.
  - **Rollout:** staging first, and production outside Yellow Balloon's ticket windows. Rolling back means reverting the commit; the Workers, bindings and routes are unchanged.
  - *Verification:* `npm run check` passes. Staging and production deploy with `cf`. The isolation probe and a sign-in on a camp site pass after the production deploy.
- **If no-go:** stay on Wrangler. Unit 2.2 keeps its generator, but the instance config stays a plain TypeScript module that a later `cloudflare.config.ts` can import. Check `cf` again when it's stable.

### Phase 2: Configuration instead of hard-coding (7–9 days)

- [x] **2.1 Instance configuration file.** *(Done 2026-10-11: `config/schema.ts` with a dependency-free validator; `config/hosted.json`, `staging.json`, `local.json`, `example.json`. One file per instance; a non-top-level instance names its Wrangler environment with `wranglerEnv`.)* Define `config/schema.ts`, validated at build time, and `config/example.json`. **`MAIL_ALLOWLIST` is not in it**: the staging allowlist lists personal addresses, so it becomes a Worker secret on staging (where it already behaves like one: staging-only and operator-controlled), or staging moves to role addresses and domain-only entries. Either way, it never lands in committed config. The config holds:
  - the apex domain and staging domain;
  - Worker names;
  - Hyperdrive IDs;
  - R2 bucket names;
  - the Turnstile site keys (camp join, sign-up);
  - Access team and AUD (optional);
  - crons;
  - rate-limit namespace IDs;
  - product name, operator name, contact and abuse email, support link (Discord or other);
  - whether the public sign-up page and operator console are enabled;
  - the email provider;
  - the `MAIL_FROM` and `ALERT_MAIL_FROM` addresses.

  Each environment (production, staging, local) is a section.
  - *Verification:* a test validates `config/example.json` and rejects a config with a missing required field.
- [x] **2.2 Generate the `wrangler.jsonc` files from config.** *(Done 2026-10-11, in two steps. First, `scripts/config-to-wrangler.ts`, with a test proving hosted + staging reproduced the hand-written files exactly. Then the switch: both files are generated and gitignored, written by `postinstall`, the CI setup action and the test setup (`config/local.json`), and by `npm run config:hosted` in the deploy jobs. The production build configs came out identical to the old ones. The staging allowlist is a Worker secret; staging is `mail.restricted`, so it sends nothing while the secret is missing, which made the switch safe without ordering tricks.)* *(If Phase 1b goes ahead, this unit becomes: each `cloudflare.config.ts` imports `config/<instance>.json`, chosen by mode. There's no generator, nothing generated is gitignored, and the `postinstall` ordering below no longer applies. The verification becomes: the hosted config produces the same Workers, bindings and routes as today's files.)* `scripts/config-to-wrangler.ts` writes `wrangler.jsonc` and `platform/wrangler.jsonc`, both gitignored and generated, from `config/<instance>.json`. The current hand-written files become the hosted config, committed as `config/hosted.json` and `config/staging.json`. `npm run dev` and the tests generate from `config/local.json`, which is committed and has only local values.
  - *Verification:* generating from the hosted config reproduces today's `wrangler.jsonc` files exactly, except for `MAIL_ALLOWLIST`, which moves to a staging Worker secret (Unit 2.1). The snapshot test asserts that difference explicitly rather than quietly preserving the old value. The existing config tests (`tests/config/*.test.ts`) run against generated files.
  - **Ordering, so a fresh clone still installs.** Today `postinstall` runs `wrangler types` against both `wrangler.jsonc` files, which won't exist on a fresh clone once they're generated. So `postinstall` first generates them from `config/local.json` (the generator runs under `tsx`, a dev dependency that's available at that point), then runs `wrangler types`.
    - In CI, `.github/actions/setup` restores `node_modules` from cache and skips `postinstall` on a cache hit. The test and build jobs get an explicit generate step; typecheck already regenerates types itself.
    - The deploy workflows generate from their instance config before `npm run build` (Unit 2.5).
    - *Verification:* `git clone` then `npm ci` on a clean machine succeeds, and CI passes both with and without the `node_modules` cache.
- [x] **2.3 Deploy-target check from config** (on `cf`'s build output if Phase 1b went ahead). *(Done 2026-10-11: `check-deploy-target.ts <instance>` reads the Worker names and zone from `config/<instance>.json`; `production` means `hosted`.)* `scripts/check-deploy-target.ts` reads the expected Worker names and zone from the config, not constants.
- [x] **2.4 Domains and names in code from config.** *(Done 2026-10-11: the product name, operator, contact address and support link reach both Workers as vars from the instance config, and the support link is optional, so its links disappear without one. The instance's reserved camp addresses come from config (`product.reservedSlugs`, `reservedParts`); there are no hard-coded domains left in app code. A page that matches no route shows no legal links rather than guessing a hosted address. The "Theme Camp App" wording itself, about 116 places, is Unit 3.5.)*
  - Replace hard-coded `themecamp.app` and `themecamp.dev` in `app/lib/camp.ts`, `app/lib/hosts.ts` and `.github/workflows/ci.yml`.
  - `app/lib/reserved-slugs.ts` keeps its general list, plus the instance's own names from config.
  - Product name, operator name, contact and support link reach the Workers as `vars`. The camp Worker already gets `APP_HOST_SUFFIX`; add `PRODUCT_NAME`, `OPERATOR_NAME`, `CONTACT_EMAIL` and `SUPPORT_URL`.
  - `app/lib/support-links.ts` reads from config, with the hosted Discord as the hosted service's value.
  - *Verification:* tests run with a non-default product name and domain (`Example Camps`, `camps.example.org`) across the site, emails and guides, and find no "Theme Camp App" or `themecamp.` except where the config supplies it.
- [x] **2.5 CI and deploys by config.** *(The rest done 2026-10-15 with 4.4.)* *(Partly done 2026-10-11 with 2.2: CI runs from `config/local.json`, and the deploy jobs generate from `hosted` + `staging`. The staging smoke check now reads the domain and product name from `config/staging.json`. Still to do: the instance as a workflow parameter for self-hosters, with Unit 4.4.)* `ci.yml` runs typecheck, lint, the tests, and building both Workers from `config/local.json`, with no secrets, on every push and pull request. The staging and production deploy workflows build from `config/staging.json` and `config/hosted.json`, inside their GitHub environments (Unit 9.1). The staging smoke check (today a `grep` for the literal "Theme Camp App" in `ci.yml`) reads the expected product name from `config/staging.json`, so it isn't one more hidden copy of the name.

### Phase 3: Make every hosted-only piece replaceable (12–15 days)

- [x] **3.1 Email adapter.** *(Done 2026-10-12: `app/lib/email/` has the interface and the Plunk and Postmark adapters; config `mail.provider` becomes the `EMAIL_PROVIDER` var. The key is `EMAIL_API_KEY` and the webhook secret `EMAIL_WEBHOOK_SECRET`, with the old Plunk names still read until the hosted secrets are renamed (`docs/operating.md`). Webhooks are `/webhooks/email/plunk/<event>` and `/webhooks/email/postmark`, since Postmark's payload names its own event; `/webhooks/plunk/<event>` still works. Tests stub the provider's API, and `npm run test:postmark` (a CI job) runs the mail tests against Postmark.)*
  - Define `app/lib/email/provider.ts`: `send(message) → result`, plus a webhook parser that turns provider events into bounces and complaints.
  - Move the Plunk calls from `app/lib/mail.server.ts` and `platform/app/lib/mail.server.ts` into `app/lib/email/plunk.ts`, and add `app/lib/email/postmark.ts`.
  - Replace the `PLUNK_SECRET_KEY` types with one `EMAIL_API_KEY`, and generalise `platform/app/webhooks/plunk.server.ts` to `/webhooks/email/<provider>/<event>`.
  - Suppression, daily caps, pausing, the allowlist and the send log stay exactly as they are, above the adapter.
  - Rename the hosted secret at cutover: `docs/operating.md` gets the steps.
  - **The test plumbing is Plunk-shaped too, and is part of this unit:** `tests/helpers/mail.ts` (`PlunkSend`, `plunkResponse`), `stubMail` in `tests/helpers/context.ts`, and the outbound interception in `tests/helpers/worker.ts` and `tests/helpers/platform.ts`. That's about 18 files carrying the key or Plunk's shapes, plus 13 test files that stub mail through them. Stub at the provider boundary instead: intercept by each provider's URL and record the provider-neutral message. Then "the same suite against Postmark" is one parameter, not a second set of fixtures.
  - *Verification:* the existing email tests pass against Plunk. The same suite runs against the Postmark adapter by switching the provider parameter. Webhook tests cover both providers' bounce and complaint shapes.
- [x] **3.2 Database operations without Neon.** *(Done 2026-10-15: the config's `database.snapshot` (`neon`, `dump` or `none`) picks the pre-migration step; `dump` is `scripts/db-dump.sh`, the same age-encrypted `pg_dump` the daily backup now uses, kept 30 days as an artifact. `scripts/restore-drill.sh` takes any `DATABASE_URL` and compares every table. The superuser-free setup is in `docs/operating.md`, and `scripts/plain-postgres-check.sh` runs it end to end with a backup and restore round trip in a CI job on PostgreSQL 16, 17 and 18, with the database and isolation tests. The full suite also passed locally on 16 and 17; in CI it runs on 18.)*
  - The pre-migration snapshot in deploys becomes a pluggable step: Neon branches (hosted), or `pg_dump` to an encrypted file (`age`, as `backup.yml` already does) for any Postgres.
  - Generalise `scripts/restore-drill.sh` to any `DATABASE_URL`.
  - `scripts/db-roles.ts` and `db-grants.ts` already work on any Postgres 15+: document the superuser-free path (roles created by the owner), and test against plain Postgres 16, 17 and 18 in CI.
  - *Verification:* the CI matrix covers Postgres 16, 17 and 18. A documented backup and restore round trip is tested on plain Postgres.
- [x] **3.3 The operator console becomes optional.** *(Done 2026-10-15: config `features.console` becomes the platform Worker's `CONSOLE` var. When it isn't `"true"`, `ops.<domain>` answers 404, and the sign-up page can't be on without the console. `npm run camp:create` (`scripts/create-camp.ts`) calls `createCamp()` with the owner connection and the instance config's vars. It is logged as kind `cli` with no operator (migration 0032), as `system` in the camp's audit log, and shown as "Command line" in the console's operator log. The invite email mentions the pilot agreement only when the instance has one.)*
  - Cloudflare Access stays the supported way to protect the console. Instances that don't want a console set `console: false`, and the platform Worker then serves only the public site, legal pages and webhooks.
  - Add `scripts/create-camp.ts`, a CLI that reuses `createCamp()` from `platform/app/lib/camps.server.ts` against `DATABASE_URL`, writing the operator log as "cli" (a new operator-log actor), so camps can be created without the console.
  - Document `scripts/add-operator.ts` for instances that do run the console.
  - *Verification:* tests cover the console disabled (its routes answer 404, the public site still works) and the CLI creating a camp and inviting its Admins.
- [x] **3.4 Single-camp instances.** *(Done 2026-10-15: config `singleCamp: { slug, host }` becomes `SINGLE_CAMP_SLUG` and `SINGLE_CAMP_HOST` on both Workers. `campSlugForHost` in `app/lib/tenancy.server.ts` checks the host first, and refuses every other host. The camp Worker's route is the host, and the platform Worker gets no routes. Camp links in emails and jobs come from `campOrigin()` in `app/lib/hosts.ts`. The camp Worker serves the legal pages itself in this mode (`app/routes/legal.$doc.tsx`, a 404 elsewhere). Config checks: the host is under the domain, and the console and sign-up page are off. Not covered: the email webhooks, which have no route in this mode (see `docs/operating.md`).)*
  - Today a camp is chosen from its subdomain (`<slug>.<domain>`). Add a `singleCamp: { slug, host }` option: every request to that host is that camp. For example `camp.example.org`, or the apex itself.
  - **Scheduled jobs stay on the platform Worker** (decided, Unit 0.1). In a single-camp instance it's deployed with no public routes: just its hourly cron and job registry (deletions, exports, support grants, feedback, usage, health). There's no new job runner.
  - The routing change is small. `campSlugFromHost` in `app/lib/tenancy.server.ts` returns no camp for the apex today, so `workers/app.ts` checks the configured single-camp host before the subdomain rule.
  - *Verification:* a test instance with `singleCamp` serves the camp at its host. Requests for other hosts are refused. The isolation tests still pass with the camp switch disabled.
- [x] **3.5 Product name, operator and branding from config.** *(Icon done 2026-10-15: config `product.icon` names a folder under `icons/`, which becomes `ICON_DIR`. Both Workers serve `/favicon.ico` and `/apple-touch-icon.png` from it before anything else, with every folder bundled like the legal pages. `icons/hosted` is the TCA icon, and `icons/default` is a neutral tent drawn by `scripts/make-icon.ts`, which also draws initials. The screenshot pass under another name is still to do.)* *(Name done 2026-10-11: every user-facing "Theme Camp App" in both Workers, emails, the Admin guide and the starter guides reads `PRODUCT_NAME`. A guard in `tests/tenancy/no-camp-strings.test.ts` fails on the literal outside comments, and a test runs both Workers as "Example Camps". A few labels became neutral, like "Support viewed …" in Activity. The icon followed on 2026-10-15.)*
  - Every user-facing "Theme Camp App" (116 occurrences in 43 files: emails, footers, the public site, the sign-up page, the Admin guide, the orientation, notifications) reads the configured product name.
  - "Kline Technology LLC" stays only in the hosted legal pages (Unit 3.6).
  - The favicon and apple-touch icon come from the instance: the TCA icon is the hosted default; the public repo ships a neutral default icon and a script to make one from initials, like the TCA icon was made.
  - The "no camp wording" guard gains a check that "Theme Camp App" doesn't appear in user-facing strings except through the product-name setting.
  - *Verification:* the Unit 2.4 renamed-instance test. A screenshot pass at 390px and 1100px of the public site, sign-in, home, Admin guide and an email, under a different name.
- [x] **3.6 Legal pages per instance.** *(Done 2026-10-12: `content/legal/` became `legal/hosted/`; `legal/templates/` has example versions with `{product}`, `{operator}` and `{contact}` filled from config, and `[square brackets]` for the self-hoster to replace, including the jurisdiction. The config's `legal: { dir, pilotAgreement }` picks the folder and turns the agreement on or off. Both Workers bundle every folder and choose at runtime (`app/lib/legal.ts`). With the agreement off: no gate, no page, no links, and the Admin guide's bullet goes.)*
  - `content/legal/` splits into `legal/hosted/` (the hosted service's own documents, as published on themecamp.app) and `legal/templates/`, **templates for self-hosters**, clearly marked as examples to adapt with their own lawyer: placeholders for the operator name, contact and jurisdiction.
  - Each instance's config names its legal directory. The build uses that one; the hosted config names `legal/hosted/`.
  - The pilot agreement, including `AGREEMENT_VERSION` and acceptance, is optional per instance (`pilotAgreement: false` skips the gate).
  - *Verification:* tests cover an instance without the agreement (Admins aren't gated) and one with custom legal pages (they're served, and the footer links work).
- [x] **3.7 Hosted-only features behind config.** *(Done 2026-10-15, except the Burning Man integration, which isn't built yet: config `features.feedback`, `usage` and `discord` join `signupPage` and `console`. Each becomes a var on both Workers, and a missing var means off (`app/lib/instance-features.ts`). Off means: the sign-up page and its host answer 404 and aren't linked; there's no feedback link and `/feedback` answers 404; no usage counts are recorded; nothing goes to Discord. Lines in `legal/templates/` ending in `{feature:<name>}` appear only when that feature is on. The hosted and staging configs turn everything on, and the example turns everything off.)* These are the public sign-up page, the Discord notifications, the in-app feedback to the operator, and the usage counts sent to the console. Each is on or off per instance, and the hosted service turns them all on. The Privacy Policy templates mention them only when they're on.
  - **The Burning Man API integration**, when it's built, is another such feature. It's on only for the hosted service, with its keys in Worker secrets, never in the repo. Its data is marked by source, so it can be deleted on its own if access ends.

### Phase 4: Self-hosting guide and setup tooling (5–6 days)

- [x] **4.1 `docs/self-hosting.md`**, the guide end to end: *(Done 2026-10-15. Prices were checked that day and are dated in the guide. Every step links to the `docs/operating.md` section with the details. It still needs its real test: someone else following it from scratch (4.2's acceptance test).)*
  - accounts needed (Cloudflare, a Postgres host, an email provider) and what they cost. Check the current prices and free tiers when writing (Hyperdrive and Images have changed tiers before), and say plainly that email is the one cost that grows with camp size. Postmark's free tier is about 100 emails a month (check this too), which a camp of 150 outgrows at once, so the realistic cost is its smallest paid plan;
  - DNS: the wildcard for multi-camp, or one host for a single camp;
  - creating the Hyperdrive, R2 bucket, Turnstile widgets and rate limits;
  - the database roles;
  - secrets, with a table of every secret and what it's for;
  - the first deploy;
  - creating the first camp and Admin;
  - backups and restore drills;
  - monitoring (health emails, the isolation probe);
  - what to do if email bounces;
  - **the Burning Man API:** a self-hosted instance that wants it needs its own agreement and keys with Burning Man. The hosted service's keys can't be shared (Burning Man's terms).
- [ ] **4.2 `scripts/setup.ts`**, an interactive setup that does what can be automated: *(Built 2026-10-15: `npm run setup`, with `--answers <file>` and `--dry-run`. The config is the record of what exists: Hyperdrive ids already in it aren't created again, an existing bucket is fine, and existing secrets (`wrangler secret list`) are kept. It turns the console and sign-up page off, since Access isn't automated. `tests/config/setup.test.ts` runs the dry run in CI. Still to do: the real end-to-end run on a throwaway account, by someone other than the author.)* *(2026-11-04: the operator waived that run before publication. Camps waiting to self-host need the public repository first, so the first of them to follow the guide is its real test, and what they hit becomes issues and fixes in 1.0.x.)*
  - asks for the domain, names and email provider, then writes `config/<instance>.json`;
  - creates the Cloudflare resources with `wrangler` (Hyperdrive, R2, rate limits);
  - runs the roles, migrations and grants against `DATABASE_URL`;
  - generates the `wrangler.jsonc` files;
  - prompts for each secret (`wrangler secret put`);
  - deploys;
  - creates the first camp and Admin (Unit 3.3).
  
  It's safe to re-run: it skips what exists.
  - *Verification:* a dry-run mode tested in CI. A real end-to-end run on a throwaway Cloudflare account and Neon or Supabase database, done by someone other than the author, following only the docs (the acceptance test for R4).
- [x] **4.3 `docs/upgrading.md`** and a `scripts/upgrade.ts` helper: *(Done 2026-10-15: the script shows the changelog sections between the running version and a tag, lists new migrations from the drizzle journal, flags upgrade notes, and with `--merge` merges the tag. Deploying stays with the workflows.)* pull a release, run migrations and grants, deploy, and what to check afterwards. Every release's notes say whether it has migrations and anything to do by hand.
- [x] **4.4 Self-hosting deploy workflow template.** *(Done 2026-10-15: both deploy workflows read the repository variables `DEPLOY_INSTANCE` (default `hosted`) and `STAGING_INSTANCE` (default `staging`; `none` skips staging). A staging config with a `wranglerEnv` is generated with the production one and built as that environment; one without is generated alone. `check-deploy-target.ts` accepts a single-camp platform Worker with no routes. The setup is section 11 of `docs/self-hosting.md`. 9.1's canonical-repository guard should let a fork that sets `DEPLOY_INSTANCE` through.)* The repository's own deploy workflows are written to work for a self-hoster's fork too: they read the instance config named in a repository variable, and need the self-hoster's own environments and secrets. Document how to set them up. It does the same thing as the hosted pipeline: check CI, snapshot, migrate, grants, build, deploy.

### Phase 5: Contributor experience (4–5 days)

- [x] **5.1 `CONTRIBUTING.md`:** *(Done 2026-10-15. The Discord #dev link waits for 5.6.)*
  - local setup (Docker Postgres, `npm ci`, `npm run check`);
  - how tests work (built Workers in workerd, a throwaway database per file, never a live database);
  - coding conventions (the existing style: plain words, comments that say why, Biome);
  - the DCO sign-off;
  - what makes a good pull request (one change, tests, screenshots for UI, migration notes);
  - which areas need extra care.
- [x] **5.2 Community files:** *(Mostly done 2026-10-15: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, the official text, reports to the contact address), `SECURITY.md`, issue templates (bug, feature, self-hosting help, and a link to private security reporting) and a pull-request template. Done 2026-10-16: `LICENSE` is the AGPL-3.0 text from gnu.org, and every source file starts with `SPDX-FileCopyrightText: 2026 Curtis Kline and contributors` and `SPDX-License-Identifier: AGPL-3.0-or-later`, which `tests/config/license-headers.test.ts` checks. Migrations are left out, since they're generated and never edited.)*
  - `CODE_OF_CONDUCT.md` (Contributor Covenant);
  - `SECURITY.md` (Unit 7.1);
  - `LICENSE`, plus SPDX headers in new files;
  - issue templates (bug, feature, self-hosting help) and a pull-request template;
  - `.github/FUNDING.yml` only if wanted later.
- [ ] **5.3 Protection on the public repo:** *(Files done 2026-10-16: `.github/CODEOWNERS` for the paths below, `.github/dependabot.yml` (npm and Actions, weekly, minor and patch grouped), and a DCO check as a workflow (`.github/workflows/dco.yml`), so no app needs installing; bots' and merge commits are left out. CI ignores `CI_RUNNER` in the canonical repository, so setting it there by mistake does nothing. Still to do at 8.3, in the repository's settings: branch protection, "Require review from Code Owners", secret scanning with push protection, and Dependabot alerts. With one maintainer, "one approving review" would block the maintainer's own pull requests, since GitHub doesn't let you approve your own: require it for others and let the maintainer bypass, or require zero reviews plus Code Owners.)*
  - **Branch protection on `main`:** pull requests only, CI required, one approving review, linear history.
  - **CODEOWNERS** requiring the maintainer's review for `drizzle/`, `scripts/db-*.ts`, `app/lib/tenancy.server.ts`, `app/lib/access.server.ts`, `app/lib/auth*.ts`, `app/lib/db.server.ts`, `platform/` (console, data rights, webhooks), `app/lib/leave-camp.server.ts`, the RLS and isolation tests, `.github/`, `config/` and `legal/`.
  - Dependabot (npm and GitHub Actions) and secret scanning with push protection.
  - The DCO app.
  - **No self-hosted runners.** Pull requests from feature branches run CI on the runner named by the `CI_RUNNER` repository variable (today the operator's self-hosted `unraid` runners; see `.github/workflows/ci.yml`). Delete that variable, or point it at a GitHub-hosted label, before the repository is public: otherwise a pull request from anyone's fork runs its code on the operator's machine. The public repository (Unit 8.1) must never have it set.
- [x] **5.4 `docs/architecture.md`**, the map contributors need, *(Done: written in 1.3 and kept current; it covers every point below.)* distilled from the plans and runbook:
  - the two Workers;
  - how a request finds its camp;
  - row-level security and the database roles;
  - roles and permissions (Lead, Treasurer, Admin, support);
  - read-only demo and suspended camps;
  - email sending and suppression;
  - files under each camp's prefix;
  - jobs;
  - data rights;
  - where tests live and what they guarantee.
- [ ] **5.5 Starter issues:** label 10–15 well-scoped issues `good first issue` and `help wanted` from the backlog (e.g. #34 UI review items, the camp join page's Turnstile hydration, more email providers, translations groundwork), each with pointers to the files involved.
- [x] **5.6 A #dev channel** *(Done 2026-10-16 by the operator; linked from CONTRIBUTING.)* on the Discord server, linked from CONTRIBUTING, for contributor questions. Bug reports and features stay in GitHub issues.

### Phase 6: Releases and versioning (2 days)

- [x] **6.1 Versioning:** *(1.0.0 set 2026-11-04 for publication day's step 1.)* *(Done 2026-10-15 except the 1.0.0 bump at publication (8.5): `package.json` is `0.9.0`. `app/lib/version.ts` bundles only the version. It shows at the foot of Admin → Guide and in the operator's feedback email. Usage counts don't carry it: there's no per-version column, and one version runs at a time.)* `package.json` gets a real version (`1.0.0` at publication). Releases are git tags (`v1.2.0`) with GitHub Releases.
  - **The running version is visible:** the build reads the version from `package.json` and shows it at the foot of Admin → Guide ("Version 1.2.0"). It's also included in the feedback and usage the operator already receives, so a support conversation can start from "which version are you on?".
  - *Verification:* a test checks Admin → Guide shows the `package.json` version.
- [x] **6.2 `CHANGELOG.md`** *(Done 2026-10-15: `.github/workflows/release.yml` publishes a GitHub release on a `v*` tag that matches `package.json`, using that version's section, which must have a Migrations heading (`scripts/changelog-section.ts`).)* in Keep a Changelog format. Each pull request adds a line under "Unreleased"; a release workflow turns it into release notes, with a **Migrations** and an **Upgrade notes** section.
- [x] **6.3 Compatibility promise**, documented: *(Done 2026-10-15, in `docs/upgrading.md`.)*
  - migrations stay forward-only and are never edited after a release;
  - configuration changes are additive within a major version, with defaults;
  - secret renames happen only in major versions, with a deprecation release before;
  - the minimum supported Postgres version.

### Phase 7: Security and privacy for public code (3 days)

- [ ] **7.1 `SECURITY.md` and private reporting.** *(Written 2026-10-15: `SECURITY.md`, and "Security fixes" in `docs/operating.md`, including the hosted-first exception. Still to do at publication (8.3): turn on private vulnerability reporting in the public repository.)* Turn on GitHub's private vulnerability reporting, and set an email for security reports. Promise a response time (e.g. 3 working days). The fix process: a private security advisory, with the fix developed in the advisory's temporary private fork; the operator **deploys it to the hosted service first**, by hand from that fork with their own credentials (`wrangler deploy` and the migration scripts, as in `docs/operating.md`), since the workflows only deploy from the canonical repository; then the fix is merged, released and disclosed.
  - **This is the one exception to "production only from release tags"** (Unit 9.1), and `docs/operating.md` and `SECURITY.md` say so plainly: during a security fix, production briefly runs a build from the private fork ahead of the public tag, and the tag follows at disclosure, usually within days. Self-hosters get a heads-up through a security mailing list or a "security" Discord announcement.
- [ ] **7.2 Pre-publication scan of the snapshot:** *(Dry run 2026-10-15 on `git archive HEAD`: gitleaks 8.21.2 and trufflehog 3.88.0 found nothing, and there are no data, dump or key files. Every email address is a placeholder, a role address or a test fixture. The test fixtures' operator name and company domain became neutral ones. Left for the operator to decide: `docs/decisions/0002-code-ownership.md` names the author, as the copyright record, and `tests/ops/create-camp.test.ts` guards the starter guides against his first name. Run it again on the final snapshot at 8.1.)* gitleaks and trufflehog on the exact tree to be published, a manual `git grep` for IDs and emails (Unit 1.3), and checks that no `.csv`, `.xlsx`, dump or key file is present. Nothing has ever been committed that needs rotating today. If the scan finds anything, rotate it before publishing.
- [x] **7.3 A public threat model**, `docs/security.md`: *(Done 2026-10-15.)* what the app protects (camp isolation, PII, sign-in), the controls (RLS, separate database roles, read-only demo and support, the daily isolation probe, CSP, Turnstile, rate limits), and what's out of scope. It helps reviewers and self-hosters, and doesn't help attackers more than the code itself.
- [x] **7.4 Privacy statements per role:** *(Done 2026-10-15: "Privacy: your role" in `docs/self-hosting.md` covers one camp (the camp decides) and many camps (as hosted). It notes nothing reports to the hosted service, and points to the template's "What's stored", "How long it's kept" and "Who else handles it". The privacy template's note covers the single-camp case. The hosted Privacy Policy already states the hosted service's role in "Who decides what".)* the hosted Privacy Policy states the hosted service's role. The self-hosting docs and legal templates explain that a self-hosted instance's operator is the controller, and list the data the app stores (from the hosted Privacy Policy's "What's stored" section) so they can write their own.

### Phase 8: Publish (2 days)

- [ ] **8.1 Create the public organization and repo** (D5). *(Prepared 2026-10-16: the organization exists. `scripts/publish-snapshot.sh <empty dir>` builds the commit from HEAD with no history, refuses unless `package.json` is 1.0.0, checks for data, key and env files, runs gitleaks and trufflehog (from Docker if needed) and the license-header check, lists every non-example email address and URL host for a read by eye, and commits with the sign-off. It pushes nothing. That's 7.2's rerun on the final snapshot. A trial on 2026-10-16's tree passed.)* Push a single commit, "Theme Camp App 1.0.0", from the cleaned tree, carrying the DCO sign-off and SPDX headers.
- [ ] **8.2 Archive this repository** *(Prepared 2026-10-16: every issue the code cites is closed, so none is transferred. `docs/architecture.md` now says what each was about instead of an old-to-new list.)* (private, read-only) as the record. From now on everyone, including the operator, works in the public repository.
  - **Issues and pull requests at cutover:**
    - transfer the open issues to the public repository (GitHub can transfer issues between repositories the operator owns; they get new numbers there);
    - close open pull requests with a pointer to the public repository (pull requests can't be transferred);
    - add the old-to-new numbers for the issues the code cites (#67, #73, #79, #82, and any others `git grep "issue #"` finds) to `docs/architecture.md` (Unit 1.2).
- [ ] **8.3 Apply the repo settings:** *(Applied 2026-10-16 to the empty public repository `themecampapp/themecampapp`, created that day. The org is on GitHub's free plan, where a private repository can't have rulesets, protected environments or private vulnerability reporting. So the repository was made public and empty, which shows nothing but the name.*
  - *Ruleset `main`: pull requests only, one approving review from Code Owners (stale approvals dismissed), the `check` and `sign-off` checks required, linear history, no deletion or force-push. Repository admins can bypass it, but only through a pull request.*
  - *Merging: squash or rebase only, since linear history rules out merge commits. Squash commits keep the commit messages, sign-offs included, and web commits need a sign-off. Branches are deleted on merge.*
  - *Environments: `production` (your approval, `v*` tags only), `staging` (`main` only), and `production-jobs` (`main` only, no approval) for the scheduled backup and isolation probe, which can't wait for an approval.*
  - *Security: private vulnerability reporting, secret scanning with push protection, Dependabot alerts and security updates.*
  - *Actions: GitHub's own and verified actions only, default token read-only, workflows can't approve pull requests, and first-time contributors' workflows wait for approval.*
  - *Issues on; wiki, projects and Discussions off. Labels include `good first issue`, `help wanted`, `self-hosting` and Dependabot's labels. Description, homepage and topics are set.*
  - *Left for the operator: require two-factor authentication in the organization's settings. You're the only member and have it on. GitHub has no API for that setting.)* branch protection, CODEOWNERS, Dependabot, secret scanning, private vulnerability reporting, the DCO app, labels, the issue templates live, and Discussions on or off.
- **Publication day, in order** *(written 2026-10-16)*:
  1. In this repository, bump to 1.0.0 (`package.json`, the lockfile, `CHANGELOG.md`'s section) and merge it.
  2. `scripts/publish-snapshot.sh <empty dir>`, then read its lists.
  3. Add the new repository's secrets and variables:
     - `staging`: the Cloudflare token and account ID, and `DATABASE_URL`;
     - `production`: those, plus the Neon keys;
     - `production-jobs`: `DATABASE_URL`, `AGE_PUBLIC_KEY`, `PROBE_DATABASE_URL`, and the variable `PROBE_CAMP_ID`;
     - the repository variable `BACKUPS_ENABLED=true`.

     Never set `CI_RUNNER`. Staging's secrets go in first, because the push to `main` deploys staging.
  4. The ruleset refuses a direct push, even an admin's. Turn it off for the first push only:
     - `gh api -X PUT repos/themecampapp/themecampapp/rulesets/25280043 -f enforcement=disabled`;
     - push `main`;
     - the same command with `enforcement=active`.
  5. Once CI and staging are green there: tag `v1.0.0`, push the tag (the Release workflow publishes the notes), and run Deploy production on the tag (8.5).
  6. In this repository: unset `DEPLOY_INSTANCE` and `STAGING_INSTANCE`, which stops its deploys (9.1); set `BACKUPS_ENABLED` to false; transfer the open issues; archive it (8.2).
- [ ] **8.4 Announce** to the interested organizers: the repo, CONTRIBUTING, the starter issues and the Discord #dev channel. Update the hosted public site and Admin guide with a "source code" link.
- [ ] **8.5 Tag `v1.0.0`** and deploy the hosted service from that tag through the public repository's production workflow (Unit 9.1). Production's code is now exactly the public release.

### Phase 9: Running the hosted service from the public repository (2 days)

- [ ] **9.1 Deploy workflows in the public repository, protected.** *(Workflows done 2026-10-16. In `themecampapp/themecampapp`, production deploys only `v*` tags. Anywhere else, it deploys `main` and only once `DEPLOY_INSTANCE` is set, and staging waits for both `DEPLOY_INSTANCE` and `STAGING_INSTANCE`. So a fork deploys nothing until it names its own config, and one that has (4.4) still deploys. The private repository has `DEPLOY_INSTANCE=hosted` and `STAGING_INSTANCE=staging` set so it keeps deploying until the move. Still to do at the move: the environments' rules (production: tags only, approval; staging: `main` only) and their secrets.)* The workflows stay where they are and keep doing what they do now: the green-CI gate, the Neon snapshot, migrations and grants, building, checking the targets and deploying both Workers. The changes:
  - **staging** deploys from `main`, and **production** from release tags (`v*`), each building from its config file (Unit 2.5);
  - the `production` environment requires the operator's approval for every run and only allows tags. `staging` only allows `main`;
  - both workflows refuse to run anywhere but the canonical repository (`if: github.repository == 'themecampapp/themecampapp'`), so a fork's copy can't do anything even with secrets of its own misconfigured;
  - the environments' secrets are recreated in the public repository (they don't move with a fresh snapshot), and the old ones are removed from the archived repository.
  - *Verification:* staging deploys from public `main`, and production from `v1.0.0` after approval, with no change visible to camps: the same Workers, routes and database. A pull request from a fork runs CI only, and its logs show no secrets. The hosted smoke checks pass: sign-in, the demo Admin sweep, the sign-up page, Discord notifications and the health email.
- [ ] **9.2 Backups and the isolation probe** *(2026-10-16: no change needed. Both are already opt-in: backups need `BACKUPS_ENABLED=true`, and the probe skips an environment without `PROBE_DATABASE_URL`. GitHub doesn't run a fork's scheduled workflows until its owner turns Actions on. In the public repository, set `BACKUPS_ENABLED` and the secrets again.)* keep running on their schedules from the public repository, in the `production` environment, with the same guard against running outside the canonical repository.
- [x] **9.3 `docs/operating.md` covers the hosted flow** *(Done 2026-10-16: "Taking a release to production" and "Reviewing pull requests" under Deploys. The security-fix flow and the email secret rename were already there.)* as the worked example: taking a release to production, the security-fix flow and its stated exception to tag-only deploys (Unit 7.1), the email secret rename (Unit 3.1), and how to review and merge community pull requests safely (especially ones touching `config/`, `legal/` or `.github/`, which CODEOWNERS routes to the operator).

## Sequencing

```
Phase 0 (decisions, legal) ──────────────────────────────┐ (legal review runs alongside)
Phase 1 (clean-up) ─► Phase 2 (config) ─┬─► Phase 3 (replaceable pieces) ─► Phase 4 (self-hosting)
                                        └─► Phase 5 (contributors) ─► Phase 6 (releases)
                                                                    Phase 7 (security) ──┐
Phase 4 + 5 + 6 + 7 + legal review done ─────────────────────────► Phase 8 (publish) ─► Phase 9 (hosted from public)
```

Every phase is merged to this repository and deployed to the hosted service as it lands, so the hosted service is always running the code that will be published. Nothing goes public until Phase 8, when a clean snapshot of it becomes the public repository and this one is archived.

## Risks

| Risk | Mitigation |
|---|---|
| A refactor (config, email adapter, branding) breaks the hosted service | Each unit lands separately with the existing ~1,000 tests plus new ones; staging first; hosted smoke checks after each production deploy. Config generation is proven by reproducing today's `wrangler.jsonc` exactly (Unit 2.2). |
| Security fixes become visible on merge | Private advisories and private-fork fixes, deployed to the hosted service before merge and disclosure (Unit 7.1). |
| A contribution weakens camp isolation or data deletion | CODEOWNERS on security-critical paths (Unit 5.3); the RLS, cross-camp and isolation test suites are required in CI; the daily isolation probe in production. |
| Self-hosted instances confused with the hosted service | Trademark policy (D4), configurable product name and icon (Unit 3.5), per-instance legal pages (Unit 3.6). |
| Maintainer review load | Clear CONTRIBUTING, templates and starter issues; CI does the first pass; it's fine to say "not now" to features outside the roadmap. |
| Hosted deploy workflows and config sit in a public repository | Secrets only in protected environments; production needs the operator's approval and only runs from tags on the canonical repository; forks and pull requests get no secrets; CODEOWNERS routes `.github/`, `config/` and `legal/` changes to the operator (Units 5.3, 9.1). |
| Self-hosters left on old, insecure versions | Releases with upgrade notes (Phase 6), a security announcement channel (Unit 7.1), and a version shown on Admin → Guide so Admins can see what they're running. |
| The work runs longer than planned | 8–10 weeks estimated with the review's input; the Postmark adapter is pre-declared flex scope that moves to a fast-follow release before v1.1 rather than delaying 1.0. |
| The legal review changes the license or terms late | Start it in Phase 0, in parallel; Phase 8 waits for it. |

## Success criteria

- The public repository passes a secrets and data scan, and `git grep` finds no credentials, personal emails, personal notes or YB material.
- There is exactly one repository with the code in it, and the hosted service deploys from it.
- Someone other than the author:
  - goes from clone to passing tests from CONTRIBUTING alone;
  - deploys a single-camp and a multi-camp instance on their own accounts from `docs/self-hosting.md` and `scripts/setup.ts`, and upgrades it across one release.
- The hosted service deploys from a public release tag with no change camps can see.
- A test instance with a different product name, domain, email provider (Postmark) and Postgres host passes the full suite.
- At least one outside contributor's pull request is merged within the first month.

## Open questions

- **[D1/D2] License and contributions:** AGPL and DCO, decided 2026-10-10. The lawyer confirms in Phase 0.
- **[2.1] Staging allowlist:** decided 2026-10-11: a staging Worker secret.
- **[D8] A third email provider:** decided 2026-10-11: later, when a self-hoster asks.
