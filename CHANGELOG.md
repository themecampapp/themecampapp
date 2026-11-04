# Changelog

Every change people or operators would notice, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow [semantic versioning](https://semver.org/), and the promises behind them are in [`docs/upgrading.md`](docs/upgrading.md).

Each pull request adds its line under **Unreleased**. A release renames that section to the version and date, and the release workflow turns it into the GitHub release's notes. Every release lists its **Migrations** (or "None") and any **Upgrade notes**: what an instance's operator must do by hand.

## [Unreleased]

### Migrations

- None yet.

## [1.0.0] - 2026-11-04

The first public release.

### Added

- Run your own instance: every hosted-only piece is a setting in `config/<instance>.json` (`docs/self-hosting.md`).
- Single-camp instances: one camp at its own address (`singleCamp`).
- Postmark as a second email provider, next to Plunk.
- Any Postgres 16 or newer, without a superuser; pre-migration snapshots by encrypted `pg_dump` as well as Neon branches.
- The operator console, sign-up page, in-app feedback, usage counts and Discord notices can each be turned off.
- `npm run camp:create` creates a camp from the command line.
- Each instance's own name, icon (`scripts/make-icon.ts`) and legal pages, with templates in `legal/templates/`.
- The running version at the foot of Admin → Guide.
- The `LICENSE` (AGPL-3.0-or-later), and license headers in every source file.
- A prompt for setting up an instance with an AI coding agent (`docs/self-hosting-agent-prompt.md`).
- A Neon walkthrough for self-hosters ("On Neon" in `docs/self-hosting.md`).
- A "Source code" link on every page, from the new required `product.sourceUrl` setting.

### Migrations

- `0032_operator_log_cli`: the operator log records commands run from the command line.
- `0033_drop_positions`: drops the old elected-position tables (`camp_position`, `position_holder`) and `camp_settings.feature_positions`, copied into jobs by `0031` (issue #106). It stops, changing nothing, if either table has rows written after 2026-10-11.

### Upgrade notes

- Add `product.sourceUrl` to your config: the public repository, or your fork once you've changed the code.
- The email secrets are now `EMAIL_API_KEY` and `EMAIL_WEBHOOK_SECRET`. The old `PLUNK_SECRET_KEY` and `PLUNK_WEBHOOK_SECRET` are still read until you rename them ("Email" in `docs/operating.md`).
