# 0001: Open-sourcing Theme Camp App

*Recorded 2026-10-11 by the operator (Kline Technology LLC). The reasoning behind each choice is in `docs/plans/2026-10-04-001-feat-open-source-plan.md`.*

Theme Camp App's code will be published as one public repository. The hosted service at themecamp.app keeps running from it, free. These are the decisions that shape how.

## D1. License: AGPL-3.0-or-later

Anyone may use, change and self-host the code. Anyone who offers a modified version to others over a network has to share their changes. That keeps improvements coming back and stops a closed hosted copy. The hosted service is unaffected, because its source is the public repo.

## D2. Contributions: DCO

Each commit carries a `Signed-off-by:` line, checked by a GitHub app. Contributors keep their copyright and contribute under the AGPL, like everyone else. No CLA: the code stays open under the AGPL and the hosted service stays free, so there's nothing a CLA would be needed for. This can't be changed later for code already contributed.

## D3. Copyright holder: Curtis Kline

*Revised 2026-10-16. It was Kline Technology LLC, which would have needed a written assignment of the code to the company.*

Curtis Kline, who wrote it, holds the copyright in the existing code, personally. There's no assignment. Kline Technology LLC operates the hosted service, which it runs under the same AGPL license as everyone else, and signs the pilot agreement. Contributors keep their own copyright under the DCO. Every source file carries `SPDX-FileCopyrightText: 2026 Curtis Kline and contributors`.

## D4. Name and marks: keep "Theme Camp App" for the hosted service

"Theme Camp App" and the TCA icon refer to the hosted service. Forks and self-hosted instances use their own name and icon, or say "based on Theme Camp App." `TRADEMARKS.md` sets this out. The product name becomes configurable (open-source plan, Unit 3.5), so a self-hosted instance never has to show it.

## D5. One public repository: `github.com/themecampapp/themecampapp`

One repository holds the code and the hosted service's configuration, legal pages and deploy workflows, in a new GitHub organization, `themecampapp`. Secrets stay in its protected `staging` and `production` GitHub environments. The hosted settings in the repo are identifiers, not credentials.

## D6. History: start from a clean snapshot

The public repository starts from one fresh commit of the cleaned tree. This repository is archived, private and read-only, as the record of how it got there. After the switch, everyone, the operator included, works in the public repository.

## D7. Runtime: Cloudflare Workers stays required

Workers, R2, Images, Hyperdrive, Turnstile and rate limiting. The architecture depends on them, and a Cloudflare account costs nothing or $5 a month. A Node or Docker runtime would be a separate project.

## D8. Email: Plunk and Postmark behind an adapter

Two real providers prove the adapter, and the docs explain how to add others. A third provider (Resend, Amazon SES) waits until a self-hoster asks for one. If the work runs long, Postmark moves to a fast-follow release rather than delaying 1.0.

## D9. Releases: semantic versioning

Tagged releases (`v1.2.0`), a `CHANGELOG.md`, and upgrade notes that say whether a release has migrations. The hosted service deploys tagged releases.

## D10. One edition

A single camp is a configuration of the same code, not a separate or reduced version. Nothing is held back, not even the operator console in `platform/`, which also runs the jobs and data deletion every installation needs.

## Decided after the outside review (2026-10-05)

- **Scheduled jobs in a single-camp instance run on the platform Worker,** deployed with no public routes, just its hourly cron and job registry. A separate job runner would be a third build target and a second code path, which D10 exists to avoid.
- **The requirements document and the pilot plan are published, redacted** (open-source plan, Unit 1.2). About 290 code comments cite their numbers, and they should keep making sense.

## Also decided (2026-10-11)

- **The staging mail allowlist becomes a staging Worker secret.** It lists personal addresses, so it never goes in committed config. Who gets staging mail doesn't change.
