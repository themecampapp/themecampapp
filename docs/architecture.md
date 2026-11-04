# How Theme Camp App works

A map for contributors. How to run an instance is in `docs/operating.md`.

## The two Workers

| | Camp Worker | Platform Worker |
|---|---|---|
| Code | `app/`, `workers/` | `platform/` (its own React Router app) |
| Settings | `config/<instance>.json`, generated into `wrangler.jsonc` | the same config, generated into `platform/wrangler.jsonc` |
| Serves | every camp at `<slug>.<domain>`, and the demo camp; a daily cron (16:00 UTC) for key-date reminders | the public site (apex; `www` redirects there), the operator console on `ops.`, the sign-up page, email webhooks, and an hourly cron for jobs and the health check |
| Database role | `app_runtime` (NOBYPASSRLS) | `app_platform` (NOBYPASSRLS) |
| Bindings | `HYPERDRIVE`, `PHOTOS` (R2), `IMAGES`, `JOIN_LIMITER` | `HYPERDRIVE_PLATFORM`, `FILES` (R2) |

- **Routing:** the platform Worker's routes (apex, `www`, `ops`, `signup`) are more specific than the camp Worker's `*.<domain>/*`, so Cloudflare sends those hosts to it. The platform imports shared code from `app/lib` through the `~` alias.
- **Placement:** both Workers use targeted placement in the database's region. Each request makes several sequential round trips to Postgres, and running near the visitor instead made a sign-in about three times slower. A config test enforces it.
- **No cross-camp bindings:** the camp Worker must never get a binding that reads across camps. `tests/config/camp-worker.test.ts` fails CI if it does.

## How a request finds its camp

1. **The camp Worker** (`workers/app.ts`) takes the slug from the host (`campSlugForHost`) and looks the camp up (`lookupCamp`).
   - A single-camp instance (config `singleCamp`) has one camp at its own host, and refuses every other host.
   - An unknown slug gets the same friendly 404 as any unknown host, so nobody can probe which camps exist.
2. **Before any route runs, the Worker enforces:**
   - same-origin writes, since all camp subdomains are one site to the browser;
   - a body size cap;
   - the demo camp's and support access's read-only rules;
   - a suspended camp's limits.
3. **Every database statement acts for that camp.** `campScopedClient` (`app/lib/tenancy.server.ts`) sets `app.camp_id` at the start of every transaction, never per session, because Hyperdrive reuses connections across requests and camps.
   - **Hyperdrive pools in transaction mode,** which plain Postgres in the tests doesn't imitate. A statement queued behind another transaction's COMMIT on the same connection can be lost there, so the client runs one short transaction at a time per connection.
   - **The database ends any transaction idle for a minute** (migration 0008).

## Row-level security and database roles

- **Every camp table has `camp_id`.** Its policy is `camp_id = current_camp_id()`, where `current_camp_id()` reads `app.camp_id`. `camp_id` defaults to the same, so inserts never pass it.
  - The policy is **forced**, so it applies to the table owner too.
  - A new camp table's migration ends with `select enable_camp_rls('<table>');`.
  - Cross-camp references use composite `(camp_id, x_id)` foreign keys.
  - The RLS catalog test and `db:grants` fail if any `camp_id` table lacks the policy.
- **The `camp` table itself has no RLS:** it's how requests find their camp.
- **Roles** (created by `scripts/db-roles.ts`):

  | Role | Login | RLS | Used by |
  |---|---|---|---|
  | `app_runtime` | yes | NOBYPASSRLS | the camp Worker |
  | `app_platform` | yes | NOBYPASSRLS | the platform Worker |
  | `app_definer` | no | BYPASSRLS | owns the few `SECURITY DEFINER` functions that read across camps |
  | `app_probe` | yes | NOBYPASSRLS | the daily isolation probe; read on camp tables only |

  - The owner (`neondb_owner` on Neon) owns the tables and runs migrations. It's granted `app_definer` with SET but not INHERIT.
  - No Worker is ever bound to the owner.
  - Grants live in one place, `scripts/db-grants.ts`.
- **Isolation is checked three ways:**
  - **the cross-camp test harness** (`tests/authz/cross-camp.registry.ts`, `tests/helpers/two-camps.ts`): every route is probed from camp A at camp B;
  - **the isolation probe** (`scripts/isolation-probe.ts`): it runs in the tests, hourly in the platform's health check, and daily in each environment;
  - **`db:grants` on every deploy.**

## Seasons

- **A season is a `burn` row** (one per year). The camp's current one is `current_year()`, which reads `camp_settings.current_year`. Most data (RSVPs, ticket requests, dues, who's in each job) belongs to a season.
- **Rolling over** (Admin page) records who actually came, creates the next season and switches to it, in one transaction. Nothing is deleted, so an Admin can switch back.

## Sign-in and people

- **Magic links only** (Better Auth, `app/lib/auth.server.ts`).
  - One login per email address across the platform, but sessions are per camp.
  - The session records its camp and is refused anywhere else (`resolveViewer`), and cookies are host-only.
  - Every magic-link token starts with the id of the camp that issued it.
- **Membership is by invitation.** A first sign-in links the login to the one person in that camp with a pending invite for that exact email. Anything ambiguous goes to the Leads' Queue.
- **A person record belongs to one camp.** The same email in two camps is two person records, with one login.

## Roles and permissions

- **What someone can do is a level in each area** of the camp's tools (`app/lib/permissions.ts`):
  - **Levels:** No access, View or Manage.
  - **Areas:** People, Private details & notes, Roster & RSVPs, Tickets, Dues, SAPs, Jobs, Inquiries, Announcements & dates, Guides.
- **Roles grant those levels:**
  - **Lead** and **Treasurer** start from defaults in code. A camp can change either, and reset it.
  - **Custom roles** are a camp's own. They're archived, never deleted.
  - **Admin** can do everything and can't be changed.
  - Someone with several roles gets the union of what they allow.
  - Every check reads the levels (`can`, `assertAccess`), never role names.
- **Routes declare their area** (`AREAS[].routes`). The `_app` layout's middleware requires the area's read level for GET and Manage for changes.
- **Only Admins give roles.** Acting on another person (their sign-in, deactivating them) needs People: Manage, plus at least everything the other person can do.
- **Private details & notes** (phone, email and home location people haven't shared, mailing addresses, notes) follow one rule, `app/lib/contact-sharing.server.ts`.
- **Jobs aren't roles.** A job is what someone does for the camp (Camp lead, Kitchen); a role is what they can do in the app.

## The demo camp, suspended camps and support access

- **The demo camp** (`kind = 'demo'`) never saves anything:
  - the Worker turns away form posts;
  - the app's root middleware refuses a page's own posts;
  - its database transactions are read-only;
  - its R2 handle refuses writes;
  - no mail is sent;
  - there's no sign-in. Visitors pick a seeded person to view it as (`/demo/enter`), and the demo cookie means nothing at any other camp.
- **A suspended camp** is read-only, except signing in and out.
- **Support access** lets the operator see a camp, read-only, only while one of its Admins has granted it (`app/lib/support.server.ts`). The Worker refuses every change made with the support cookie. Every page viewed is in the camp's Activity.

## Email

**Before every send** (`app/lib/mail.server.ts`), in order:
1. the staging allowlist;
2. the suppression list (any camp's bounce or complaint);
3. a suspended or paused camp sends only account mail, and a demo camp sends nothing;
4. invites, nudges, announcement emails and reminders stop at the camp's `daily_send_cap` over 24 hours.

Each hold is logged in `send_log`, and Leads see why on the page.

- **Senders:** camp mail and account mail have separate senders, each named "<Camp> via <product>." Reply-to is the camp's contact email.
- **Bounces and complaints:** they arrive at the platform Worker's webhook. It suppresses the address, and pauses a camp whose last 7 days pass 4% bounces or 0.1% complaints (at least 20 sends).
- **Edited email wording** can't contain web or email addresses; `{link}` is the only link.

## Files

- **One private R2 bucket** per environment. Every object is under its camp: `camps/<camp id>/p/…` (photos), `…/sap/…` (Setup Access Passes), `…/logo/…`.
- **Serving:** photos and PDFs go only to that camp's members, and only when the key is under the camp's prefix and one of its rows points at it. The logo is public, because the sign-in page shows it.
- **Cleanup:** replacing or removing a file deletes the old object. Deleting a camp removes its whole prefix.

## Jobs, alerts and usage

- **Hourly at :07,** the platform Worker runs its jobs (`platform/app/jobs/registry.server.ts`):
  - finalizing camp deletions;
  - settling expired support grants;
  - feedback notices and expiry;
  - usage and sign-up expiry;
  - then the health check (`health.server.ts`), which emails the operator about paused or failing email, sign-in failures, failed jobs and isolation problems, at most once a day each.
- **Daily at 16:00 UTC,** the camp Worker sends key-date reminders.
- **Usage counts** (`usage_daily`) are written after each response, never holding it up, and shown in the console.

## Data rights

- **Exports, camp deletion and login deletion** are recorded by the operator, confirmed by the requester from a link on their camp's site, then carried out from the console (`platform/app/lib/data-rights.server.ts`).
- **A deleted camp** closes at once and is deleted for good 30 days later.
- **The platform never touches Better Auth's tables directly:** a login is found and removed through `login_id` and `forget_login` (migration 0014).

## Camp settings, features and guides

- **Admins edit the camp's settings** (name, accent colour, contact, inquiry notifications, ticket limit, payment methods) and switch features on and off (`app/lib/features.ts`).
  - The features: dues, the join page, Yearbook, SAPs, jobs and mailing addresses.
  - A switched-off feature's pages answer 404 and its navigation, questions and emails disappear. Its data stays.
- **Page wording** (`app/lib/page-text.ts`) and **email templates** are each camp's own, with defaults in code.
- **Guides** are rows per camp (`guide`), written in Markdown by Leads and Admins. Rendering (`app/lib/markdown.server.ts`) shows raw HTML as text, turns images off, and allows only relative or `https` links, each `nofollow noopener ugc`.
  - New camps copy guides from the starter library in `content/starter-guides/`.
- **Camp wording:** no camp's name or in-jokes are built into the app; `tests/tenancy/no-camp-strings.test.ts` checks.

## Tests

- **Vitest against a local Postgres 18:** every test file gets its own throwaway database, migrated from `drizzle/` and seeded with one test camp (`tests/helpers/seed.ts`). CI also runs the database and isolation tests, and the superuser-free setup with a backup and restore round trip, on PostgreSQL 16, 17 and 18.
- **Request tests run the real built bundles in workerd** through Miniflare (`tests/helpers/worker.ts`, `tests/helpers/platform.ts`).
- **Every route must be in the cross-camp registry,** and public routes are listed explicitly (`tests/authz/routes.test.ts`).

## Reading the code comments

Comments often cite where a decision came from:

- **`R12`, `R74`…** are requirements in `docs/brainstorms/2026-09-28-multi-camp-platform-requirements.md`.
- **`U15`, `U17`…** are implementation units in `docs/plans/2026-09-28-001-feat-multi-camp-platform-pilot-plan.md`. Later plans in `docs/plans/` use their own unit numbers, named with the plan.
- **`issue #73`, `#93`…** are GitHub issues in the private repository the project started in. Every one the code cites was closed before the move to the public repository, so they weren't transferred, and the archive isn't public. What each was about is below. (Issues still open at the move were transferred and got new numbers; nothing in the code cites them.) The public repository's own #29, #73 and so on are different issues.

| Issue | About |
|---|---|
| #29 | Instructions on volunteer jobs |
| #30 | A link to your own profile |
| #31 | Past seasons |
| #32 | Slack notifications |
| #56 | Admins editing the app's text |
| #57 | Removing the operator's company name from the app |
| #62 | Phone layout improvements |
| #63 | Customizing dues |
| #64 | The demo camp's design |
| #65 | Orientation for Leads and Admins |
| #67 | A neutral default look, not the first camp's |
| #73 | The sign-up page |
| #75 | The favicon |
| #78 | Members' home addresses |
| #79 | Moving notifications from Slack to Discord |
| #82 | The Discord server link |
| #84 | An error on the demo camp |
| #88 | The import page's missing file button |
| #90 | The open-source plan (a pull request) |
| #93 | Permissions per area |
| #97 | A better 404 for camp addresses |
| #99 | The home page's wording |
| #103 | The Burning Man disclaimer in the footer |
| #106 | Elected positions and volunteer jobs merged into one list of jobs |
