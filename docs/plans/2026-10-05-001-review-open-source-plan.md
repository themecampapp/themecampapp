---
title: "review: the open-source plan — codebase verification and recommended revisions"
type: review
status: final
date: 2026-10-05
reviewed: docs/plans/2026-10-04-001-feat-open-source-plan.md (as revised 2026-10-05), at commit 5f152c7
---

# Review of the open-source plan

## What this review did

Read the plan, then checked its claims against the code: the two Workers and their configs, the
tenancy and mail layers, the jobs registry, all four workflows, the test setup and helpers, the
runbook, the scripts named in the plan, a scan of every git revision for secret patterns, and the
license inventory in `package-lock.json`. Every claim checked is listed below with what was found.

## Verdict

**Adopt, with the revisions in this document.** The plan is unusually well grounded: nearly every
factual claim about the codebase holds, the sequencing is right (clean → config → replaceable →
docs → contributors → releases → security → publish → hosted cutover, with the hosted service
always running the code that will be published), and the four structural decisions — one codebase
(D10), one repository (D5), fresh history (D6), AGPL + DCO (D1/D2) — are all argued correctly for
this codebase. Nothing found here changes those decisions.

The findings below are real but none are structural. They sort into:

- **two decisions to settle before Phase 1** (§"Decide before Phase 1 starts");
- **five unit-level corrections** the plan needs before the phase it affects (F1, F4, F6, F7, F8);
- **smaller corrections and notes** (F2, F3, F5, F9, F10);
- **estimate and scope adjustments** (§"Estimate and scope").

One point in the plan's favor it doesn't make itself: starting the public repository from a fresh
snapshot (D6) means the history-scan risk drops to near zero regardless of what any scan missed.
D6 is quietly doing a lot of the security work in Phase 7.

## Claims checked against the code

| Plan claim | Check | Result |
|---|---|---|
| No secrets in git history | Scanned every revision for key/token/connection-string patterns (`sk_…`, `AKIA…`, `ghp_…`, non-local `postgres://` user:pass hosts, long bearer tokens) | Nothing beyond test placeholders (`sk_test`, `test:test`). Confirmed. |
| No member data in the repo | Import fixtures reviewed | Confirmed; synthetic people only. |
| CI is fork-safe | Read all four workflows | Confirmed. PR jobs use no secrets; `deploy-staging` requires `main` + non-PR event; production is manual, in the `production` environment, gated on a green CI run for the exact SHA. |
| Dependency licenses compatible with AGPL-3.0 | `package-lock.json` inventory | Confirmed: MIT (366), Apache-2.0 (28), MPL-2.0 (24), ISC (21), LGPL-3.0 (10), BSD, 0BSD, CC0. No restrictive licenses. (LGPL in a network-served app imposes no source obligation beyond what AGPL already does.) |
| The "ties to the hosted service" inventory | Checked each named file | Complete and accurate as far as this review could tell: both `wrangler.jsonc` files, `scripts/check-deploy-target.ts`, `app/lib/camp.ts`, `hosts.ts`, `reserved-slugs.ts`, `support-links.ts` (hard-coded Discord invite at `app/lib/support-links.ts:4`), Plunk in ~14 source modules, Neon in `scripts/neon-snapshot.sh` and `scripts/restore-drill.sh`, the runbook's account IDs and secrets inventory. |
| "Theme Camp App" 116 times in 43 files | Counted | 114 lines across ~50 files in `app/`, `platform/`, `workers/`, `public/`, `content/`. Close enough; the sweep in Unit 3.5 is scoped correctly. |
| ~1,000 tests | Counted | 92 test files, 738 `it(…)` cases; `it.each` expansions plausibly reach ~1,000. |
| CODEOWNERS paths (Unit 5.3) all exist | Checked | Yes: `tenancy.server.ts`, `access.server.ts`, `auth.server.ts` (+ `auth-events.ts`, `auth-log.server.ts`), `db.server.ts`, `leave-camp.server.ts`, `scripts/db-*.ts`, `drizzle/`, `platform/`. |
| `createCamp()` reusable by a CLI (Unit 3.3) | Read it | Yes: `platform/app/lib/camps.server.ts:56`, takes its dependencies as arguments. |
| Migrations forward-only | Listed `drizzle/` | 30 migrations, sequential, consistent with R9. |

## Findings

### F1 — Unit 1.1, as written, breaks the test suite

`tests/import/apply.test.ts` and `tests/import/history.test.ts` import directly from the YB-only
scripts the unit deletes:

```
tests/import/apply.test.ts   → scripts/import-2026/{apply-lib, decisions, extract}
tests/import/history.test.ts → scripts/import-history/{apply-lib, decisions, extract}
```

The fixtures `tests/import/fixture.ts` and `tests/import/history-fixture.ts` exist only to feed
them. Deleting the scripts without these tests fails `npm run check` — the unit's own verification
step, so it would be caught in the moment, but at the cost of a confusing failure.

**Recommended edit (Unit 1.1):** name the test files. Delete `tests/import/apply.test.ts`,
`tests/import/history.test.ts`, `tests/import/fixture.ts`, `tests/import/history-fixture.ts`
alongside the scripts. Keep `tests/import/normalize.test.ts` and `tests/import/csv-import.test.ts`:
they test shared code that stays (`app/lib/import/normalize.ts`, `app/lib/data/csv-import.server.ts`).

### F2 — 229 in-code references to the private planning documents

Code comments cite the internal requirement and unit numbers extensively: `R74` (15×), `R65` (12×),
`R39` (12×), `R67` (9×), `issue #73` (7×), and so on — 229 `R##`/`U##`/`issue #…` references across
`app/`, `platform/`, `workers/`, `scripts/` (e.g. `workers/app.ts:23` "R74", `app/lib/features.ts:1`
"R20", `platform/wrangler.jsonc:18` "Issue #73"). Unit 1.2 decides whether the requirements doc and
pilot plan are published or distilled, but doesn't connect that decision to the comments citing
them. If the docs are dropped, every one of those references dangles for a public contributor.

**Recommended edit (Unit 1.2):** make the decision explicitly cover the code comments, and prefer
publishing the requirements doc (with account IDs and personal details removed — the same redaction
Unit 1.3 already defines) so the R-numbers keep their referent. If the operator would rather not
publish it, add a short glossary to `docs/architecture.md` (Unit 5.4): one line per frequently
cited R##/U##. Rewriting 229 comments is not worth it and would churn blame for nothing.

### F3 — What happens to the GitHub issues at cutover is unaddressed

The plan and the code both cite issue numbers (`#34` in Unit 5.5's starter issues; `#67`, `#73`,
`#79`, `#82` in code comments). D6 archives this repository and Phase 8 creates a new organization
repository — but nothing says whether open issues and pull requests come along. GitHub supports
transferring issues between repositories (including across organizations you own); PRs don't
transfer.

**Recommended edit (new bullet in Unit 8.2):** decide now and record it: transfer open issues to
the public repository at cutover (preserves numbers, keeps code comments resolvable), close
superseded PRs with a pointer. Note that issue transfer preserves issue numbers only within the
target repo's own numbering — transferred issues get new numbers, so transferred-and-renumbered is
the realistic outcome; a one-line note in `docs/architecture.md` mapping old → new numbers for the
handful the code cites (#67, #73, #79, #82) is enough.

### F4 — Staging's `MAIL_ALLOWLIST` contains personal addresses, and Phase 2 would commit them again

Both Worker configs hard-code the staging mail allowlist with the operator's personal addresses:

- `wrangler.jsonc:65`: the staging allowlist, two personal addresses and a personal domain
- `platform/wrangler.jsonc:73` — same

Unit 2.2 turns these files into generated output from committed `config/staging.json`, so the
addresses would land in the public repository — directly against R1 ("no personal notes or contact
details") and the Unit 1.3 verification (`git grep` finds no personal emails).

**Recommended edit (Unit 2.1):** the config schema should not carry `MAIL_ALLOWLIST`. Keep it a
Worker secret on staging (it already behaves like one: staging-only, operator-controlled), or move
staging to a role address and domain-only entries. Also state in Unit 2.2 that the generated
staging vars must not include it, so the snapshot test ("reproduces today's `wrangler.jsonc`
exactly") gets adjusted for the moved value rather than silently preserving it.

### F5 — The plan lists two files that don't exist

"Where things stand" and Unit 1.2 say `docs/reviews/` and `docs/plans/2026-09-30-security-and-ux.md`
"stay private" — neither exists in the working tree or anywhere in git history (the September 30
review material became `2026-09-30-001-feat-lead-workspace-ux-plan.md`, which is public-candidate).
Presumably they were never committed.

**Recommended edit:** correct the list, so nobody spends Phase 1 looking for them.

### F6 — "A version shown on Admin → Guide" has no unit

The Risks table cites "a version shown on Admin → Guide so Admins can see what they're running" as
part of the stale-self-hoster mitigation, but no unit implements it.

**Recommended edit (Unit 6.1):** add it there — read the version from `package.json` at build time,
surface it on the Admin guide page, and include it in the feedback/usage the operator already
receives so support conversations can start from "which version are you on?".

### F7 — Unit 2.2's generated `wrangler.jsonc` breaks `npm ci` on a fresh clone

`package.json:16` (`postinstall`) runs `wrangler types … -c platform/wrangler.jsonc`, which reads
the config file. Once both `wrangler.jsonc` files are gitignored and generated (Unit 2.2), a fresh
clone's `npm ci` fails before anything exists that could generate them. `preinstall` can't help —
wrangler isn't installed yet at that point.

**Recommended edit (Unit 2.2):** make `postinstall` generate before it typegens: the generation
script runs under `tsx` (a devDependency, available at `postinstall` time), writing both files from
`config/local.json`, then `wrangler types` runs against them. Spell out the same ordering for CI
(`.github/actions/setup` caches `node_modules` and skips the postinstall on a cache hit — the
typecheck script already regenerates types itself, so only the wrangler files need a generate step
added to `test`/`deploy` job paths) and for the deploy workflows (generate from the instance config
before `npm run build`, per Unit 2.5).

### F8 — The security-fix flow contradicts "production deploys only from tags" as written

Unit 7.1 has the operator deploy a fix to production by hand from a private advisory fork; Unit 9.1
(and R6's spirit) says production deploys only from release tags on the canonical repository. During
every security fix, the second statement is temporarily false. This is the right trade — deploying
the fix before disclosing it is the whole point — but two requirements contradicting each other on
paper becomes a problem the first time a contributor or auditor reads both.

**Recommended edit (Unit 7.1 or 9.3):** state the exception explicitly in `docs/operating.md`:
"during a security fix, production briefly runs a private-fork build ahead of the public tag; the
tag follows at disclosure, and the window is measured in days." Add a matching sentence to the
compatibility/security docs so the public position is honest about it.

### F9 — The staging smoke check greps the product name

`.github/workflows/ci.yml:102` checks staging by grepping the page for the literal string
"Theme Camp App". Under Units 2.4/3.5 the product name becomes config-driven. The hosted value
doesn't change, so the check keeps passing, but it's now one more hidden hard-coding of the name.

**Recommended edit (Unit 2.5):** have the check read the expected string from
`config/staging.json` (or keep the literal deliberately, with a comment saying the hosted name is
expected to stay). Either is fine; silent is not.

### F10 — The email adapter's test rework is bigger than "about a dozen modules"

Unit 3.1's estimate covers the ~14 source modules carrying `PLUNK_SECRET_KEY`, but the test
plumbing is Plunk-shaped too: `tests/helpers/mail.ts` defines `PlunkSend`/`plunkResponse`
(`tests/helpers/mail.ts:17,27`), `tests/helpers/context.ts` (`stubMail`) stubs a Plunk response,
`tests/helpers/worker.ts` intercepts outbound fetch by Plunk's request/response shape, and
`tests/helpers/platform.ts` does the same for the platform Worker — 18 files in total carry the
key or the shapes, plus 13 test files that stub mail through them.

**Recommended edit (Unit 3.1):** count the helper rework in the unit. The clean seam is to stub at
the provider boundary (intercept by URL prefix per provider, or mock the adapter module) rather
than by response shape, which is also what lets "the same suite runs against the Postmark adapter"
be one parameter instead of a second fixture set.

## Decide before Phase 1 starts

**1. Where scheduled jobs run in single-camp mode (Unit 3.4's open question).** Decide now:
**keep the platform Worker, serving nothing public.** Reasons: the hourly cron and its job
registry already exist there and are tested (`platform/app/jobs/registry.server.ts`,
`platform/workers/app.ts:130`); a shared job runner is a third build target, a new import graph,
and new failure modes — exactly the second code path D10 exists to avoid. The single-camp routing
change itself is small: `campSlugFromHost` (`app/lib/tenancy.server.ts:37`) returns null for the
apex today, so `workers/app.ts:103` needs an explicit single-camp host match before the suffix
check — an afternoon, not a design question. Record the decision in Unit 0.1's decision doc.

**2. Which planning documents go public (Unit 1.2), together with F2's glossary.** These are one
decision: the fate of the R## references depends on the fate of the docs. Recommendation above —
publish the requirements doc and pilot plan redacted; the redaction work is already defined by
Unit 1.3's greps.

## Estimate and scope

The 6–7 week total is optimistic. Phase 3 in particular (8–10 days) contains four
multi-day-by-themselves items: the email adapter with two providers and provider-parametrized tests
(F10), console-off plus the camp-creation CLI, single-camp mode, and a 116-string debranding sweep
with screenshot verification across two viewports. Phase 2's 5–7 days includes the config
generator, its snapshot test, the postinstall/CI ordering work (F7), and the renamed-instance test
across the site, emails and guides.

**Recommendation:** plan for **8–10 weeks elapsed**, and pre-declare the flex scope now rather than
discovering it mid-Phase-3: **the Postmark adapter (D8's second provider) is the first thing to
slip.** One real provider behind a documented adapter interface still ships the design; Postmark
can follow as a fast-forward PR before v1.1. Don't let the debranding sweep (3.5) or legal split
(3.6) slip instead — everything downstream (self-hosting docs, the trademark position, R4's
acceptance test) leans on them.

R3's "clone to passing tests in under 15 minutes" is plausible but tight: `npm run check` runs
typegen, `tsc -b`, lint, builds both Workers, and runs ~740 tests. When the acceptance test
happens (success criteria), have the tester use a middling laptop, not a dev workstation — that's
the population R3 is really about.

## Notes for the self-hosting guide (Unit 4.1)

- **Postmark's free tier is 100 emails/month.** A camp of 150 people sending invites, reminders
  and sign-in links will outgrow it immediately; the realistic cost is the $15/month tier. The
  cost table should say plainly that email is the one line item that scales with camp size.
- While writing 4.1, **verify the current free/paid lines for Hyperdrive and Images** on a
  self-hoster's plan rather than trusting memory; both have changed tiers over time and the guide's
  "what they cost" table is where a wrong number does the most damage.

## Suggested edits, by unit

| Finding | Plan unit | Edit |
|---|---|---|
| F1 | 1.1 | Delete the four YB import test/fixture files with the scripts; keep `normalize.test.ts` and `csv-import.test.ts`. |
| F2, decision 2 | 1.2 | Fold the R##/U##/issue-# code-comment references into the docs decision; prefer publishing the requirements doc redacted, else a glossary in `docs/architecture.md`. |
| F4 | 2.1 | `MAIL_ALLOWLIST` is a staging Worker secret, not config; adjust 2.2's snapshot test for the moved value. |
| F7 | 2.2 | `postinstall` generates both `wrangler.jsonc` files from `config/local.json` before `wrangler types`; add generate steps to the CI/deploy job paths. |
| F9 | 2.5 | The staging smoke grep reads the product name from config (or keeps the literal with a comment). |
| F10 | 3.1 | Scope the test-helper rework (18 files) in; stub at the provider boundary so the Postmark run is one parameter. |
| Decision 1 | 3.4 / 0.1 | Single-camp keeps the platform Worker with no public routes; decide now, record in the decision doc. |
| F6 | 6.1 | Add the Admin-guide version display (build-time version, shown and reported). |
| F8 | 7.1 / 9.3 | State the security-fix exception to "production only from tags" in `docs/operating.md`. |
| F3 | 8.2 | Add the issues/PR cutover step (transfer issues; note renumbering for #67/#73/#79/#82). |
| F5 | "Where things stand" | Remove the two phantom paths. |
| — | Risks / estimate | 8–10 weeks elapsed; Postmark adapter pre-declared as flex scope. |
