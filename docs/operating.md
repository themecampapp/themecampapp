# Operating Theme Camp App

How to run an instance: deploys, the database, email, the console, alerts, incidents, data requests, backups and restores. How the pieces work is in `docs/architecture.md`.

The hosted service (themecamp.app, run by Kline Technology LLC) is the worked example throughout. Every instance's settings are in `config/<instance>.json` (`config/schema.ts` says what each one means; `config/example.json` is the template). The two Workers' `wrangler.jsonc` files are generated from them and gitignored: `npm run config:local` for development and tests, `npm run config:hosted` for the hosted service's deploys. Change the config, never the generated files. Account-level details of the hosted service (who owns which account, recovery contacts) aren't kept in this repository.

## Environments and resources

The hosted service runs two environments in one Cloudflare account. Its resources all start with `tca-`.

| | Production | Staging |
|---|---|---|
| Domain | `themecamp.app` | `themecamp.dev` (fictional data only) |
| Workers | `tca-camps`, `tca-platform` | `tca-camps-staging`, `tca-platform-staging` |
| Neon project | production project | staging project (separate, so they share nothing) |
| Region / Postgres | `aws-us-west-2`, 18 | `aws-us-west-2`, 18 |
| Hyperdrive, camp (`app_runtime`) | `tca-camps` | `tca-camps-staging` |
| Hyperdrive, platform (`app_platform`) | `tca-platform` | `tca-platform-staging` |
| R2 bucket | `tca-files` | `tca-files-staging` |
| Rate-limit namespace | `2001` | `2002` |
| Mail | everyone | only the staging allowlist, the `MAIL_ALLOWLIST` Worker secret on both staging Workers; with no allowlist, nobody (`mail.restricted`). Others are logged as `skipped` |

The ids (Hyperdrive, buckets, rate limits, Turnstile site keys) are in `config/hosted.json` and `config/staging.json`. Every Hyperdrive config has caching **disabled**.

### DNS (once per zone)

Worker routes only receive traffic for hostnames with a **proxied** DNS record. On each zone, add:

| Type | Name | Content | Proxy |
|---|---|---|---|
| AAAA | `@` | `100::` | Proxied |
| AAAA | `*` | `100::` | Proxied |

The wildcard covers `www`, `ops` and every camp. Cloudflare's free certificates cover the apex and first-level subdomains only, which is why staging uses its own domain instead of `*.staging.themecamp.app`.

## Deploys

- **Staging:** every push to `main` runs `.github/workflows/ci.yml`:
  1. typecheck, lint, and the full test suite against Postgres 18;
  2. migrations and `db:grants` on the staging database;
  3. both Workers deploy to staging, and CI checks the staging site answers.
- **Production:** by hand, with **Actions → Deploy production**. What it deploys depends on the repository:
  - **The canonical repository (the hosted service)** deploys only a release tag (`v1.2.0`): run the workflow on the tag. See "Taking a release to production".
  - **A fork (a self-hosted instance)** deploys `main`, and only once the repository variable `DEPLOY_INSTANCE` names its config. Staging likewise waits for `DEPLOY_INSTANCE` and `STAGING_INSTANCE`. Until they're set, a fork's pushes run CI and deploy nothing.
  - Either way, it first checks that CI / Staging passed on `main` for that exact commit, and refuses otherwise, so the tests aren't run twice.
  - Then it snapshots the production database, migrates, runs `db:grants`, builds, checks the build targets production (`scripts/check-deploy-target.ts`), and deploys both Workers.
- **By hand (emergency or first setup):** `npm run deploy:staging` or `npm run deploy` from a clean checkout of `main`, logged in with `npx wrangler login`.
- **Scheduled jobs:** the daily backup and isolation probe run from `main` without anyone approving them, so in the canonical repository they use the `production-jobs` environment (`main` only, no approval) with just their own secrets: `DATABASE_URL`, `AGE_PUBLIC_KEY` and `PROBE_DATABASE_URL`, and the variable `PROBE_CAMP_ID`. A fork uses `production` for them.
- **Rolling back:** redeploy the last good commit (on the canonical repository, the previous release's tag). After a bad migration, restore from the `pre-migration-<sha>` snapshot first (Restore).

### Taking a release to production (the hosted service)

1. **On `main`, once staging has run what's going out:** in `CHANGELOG.md`, rename **Unreleased** to the version and date (`## [1.2.0] - 2027-02-01`), check it lists the Migrations and any Upgrade notes, and set the same version in `package.json` (and `package-lock.json`'s top two entries). Merge that as a pull request.
2. **Tag it:** `git tag v1.2.0 <that merge commit> && git push origin v1.2.0`. The Release workflow checks the tag against `package.json` and publishes the GitHub release, with the changelog section as its notes.
3. **Deploy:** **Actions → Deploy production → Run workflow**, choosing the tag. The `production` environment asks for your approval.
4. **Do the Upgrade notes** that apply to the hosted service, in the order they say.
5. **Check it:** the site, sign-up page, demo camp and a sign-in on a camp, and that the next hourly health email is quiet.

A fix that can't wait for the next release is a patch release (`1.2.1`) through the same steps. The only time production runs something that isn't a release is a security fix ("Security fixes").

### Reviewing pull requests

Pull requests from forks run CI with no secrets, on GitHub's runners, and can't deploy: staging deploys only from `main`, and production only from a tag. What reaches camps is what you merge, so:

- **Read the whole diff before merging,** including tests and lockfile changes. A test can be made to pass by weakening it.
- **CODEOWNERS** (`.github/CODEOWNERS`) asks for your review on the areas that hold camps apart, sign-in, data rights and deletion, and on `.github/`, `config/` and `legal/`. Be strictest there:
  - **`.github/`:** a workflow change runs with the repository's permissions once merged. Check what new steps run on `main` and which secrets they see.
  - **`config/`:** check no change sends mail, files or traffic anywhere new, and `scripts/check-deploy-target.ts` still names the hosted Workers and zone.
  - **`legal/`:** only you change the hosted service's legal pages. Suggest a wording change in an issue instead.
  - **Migrations:** read the SQL, not only the schema change. A new camp table needs its row-level security policy.
- **The DCO check** must pass: every commit signed off.
- **Dependabot's** grouped pull request each week runs the same CI. Merge it once it's green, after reading the changelog of anything on the sign-in or database path.

## Database roles and grants

**Create roles with SQL, never in the Neon console, CLI or API.** Those join `neon_superuser`, which bypasses row-level security. `npm run db:roles` (`scripts/db-roles.ts`) creates them; `docs/architecture.md` explains what each is for.

**Any Postgres 16 or newer works, without a superuser** (CI checks 16, 17 and 18 with `scripts/plain-postgres-check.sh`). Everything runs as one owner role, set up once by whoever administers the server (Neon's `neondb_owner` is already like this):

```sql
create role tca_owner login createrole bypassrls password '<32+ random characters>';
create database tca owner tca_owner;
```

Then, with `DATABASE_URL` the owner's connection: `npm run db:roles` (with the password variables), `npx drizzle-kit migrate`, `npm run db:grants`. The owner must create the app's roles itself: without being a superuser, it can manage only roles it has admin rights on, which it gets by creating them. It needs `BYPASSRLS` to create `app_definer`, and none of the roles it creates can bypass row-level security except that one, which can't log in.

**Grants** live in one place, `scripts/db-grants.ts`. `npm run db:grants` (owner connection) re-applies them after every migration and **fails the deploy** if:
- a login role can bypass row-level security, is a superuser, can create roles, or belongs to another role;
- `app_definer` can log in;
- a Worker role owns anything;
- either Worker role can change `audit_log`;
- `app_runtime` can change `camp`;
- any table with `camp_id` lacks forced row-level security with the `camp_isolation` policy.

**Setting or rotating a role's password.** `openssl rand -hex 24` makes a suitable one; the script insists on 32 or more letters or digits. Both Workers lose the database between the two steps, so do them together:

```sh
OWNER=$(neonctl connection-string --project-id <project> --role-name neondb_owner --database-name neondb)
RT=$(openssl rand -hex 24); PF=$(openssl rand -hex 24)
DATABASE_URL="$OWNER" APP_RUNTIME_PASSWORD="$RT" APP_PLATFORM_PASSWORD="$PF" npm run db:roles
npx wrangler hyperdrive update <camp hyperdrive id> --origin-password="$RT"
npx wrangler hyperdrive update <platform hyperdrive id> --origin-password="$PF"
```

The passwords live only in Hyperdrive. Running `npm run db:roles` without the password variables only creates what's missing, and leaves passwords alone.

**Stuck connections.** If a page hangs on staging but not in the tests, look for connections left idle in a transaction first:

```sql
select pid, state, now() - state_change, query from pg_stat_activity
where usename = 'app_runtime' and state = 'idle in transaction';
```

## Email

**The provider** is `mail.provider` in the instance config: `plunk` or `postmark` (`app/lib/email/`). Its API key is the `EMAIL_API_KEY` secret on both Workers. The bounce and complaint webhooks send `Authorization: Bearer <EMAIL_WEBHOOK_SECRET>` (a platform Worker secret, 32+ random characters). Everything else is the same for either provider: the allowlist, suppression, daily limits, pauses and `send_log`.

**Senders:** camp mail goes from `mail.from` (`notify@mail.<domain>`) and account mail (sign-in links, email changes) from `mail.authFrom` (`signin@auth.<domain>`). The operator's alerts go from `mail.alertFrom`. Every sending domain must be verified with the provider.

**Plunk** (https://docs.useplunk.com) is the hosted service's provider. It uses one Plunk project for both environments, with all four sending domains verified in it, so staging and production share its secret key.

- **Keep the project's tracking off** (Settings → Tracking). With tracking on, even "Marketing only," Plunk rewrites every link through its tracking domain, sign-in links included. That passes sign-in tokens through a third party. Plunk only skips tracking for its own templates, and there's no per-email switch, so it has to be off for the whole project.
- **Bounce and complaint webhooks:** set up two Plunk workflows per project, one triggered by `email.bounce` and one by `email.complaint`.
  - Each has a single **Webhook** step: `POST https://<domain>/webhooks/email/plunk/bounce` (or `/complaint`), with headers `{"Authorization": "Bearer <EMAIL_WEBHOOK_SECRET>"}` and no custom body. The old address, `/webhooks/plunk/<event>`, still works.
  - Each environment has its own pair. Each event reaches both platform Workers, and each acts only on messages it sent itself.
  - Plunk doesn't retry a failed webhook. An event that arrives while the Worker is down is lost.

**Postmark** (https://postmarkapp.com/developer):

- `EMAIL_API_KEY` is the **Server API token** of a Postmark server, not the account token. The app sends on the server's default transactional stream, `outbound`.
- The app turns open and link tracking off on every email, so Postmark never rewrites sign-in links.
- **Bounce and complaint webhook:** one webhook on the `outbound` stream (Servers → the server → Webhooks):
  - URL: `https://<domain>/webhooks/email/postmark`.
  - Custom header: `Authorization` set to `Bearer <EMAIL_WEBHOOK_SECRET>`.
  - Triggers: **Bounce** and **Spam Complaint**. Other events are accepted and ignored.
- Postmark retries a failed webhook for a while, and each event is acted on once.
- A soft bounce changes nothing. A hard bounce, an address Postmark has deactivated, or a spam complaint suppresses the address.

**Switching provider:**

1. Verify the sending domains with the new provider.
2. Set up its webhook.
3. Put its key in `EMAIL_API_KEY` on both Workers.
4. Change `mail.provider` and deploy.

Leave the old provider's webhooks in place for a few days: bounces for mail it already sent still arrive, and any provider's address is accepted.

**Moving from the old secret names** (`PLUNK_SECRET_KEY`, `PLUNK_WEBHOOK_SECRET`; the Workers still read them while the new ones are missing):

1. For each Worker and environment, put the same values under the new names: `npx wrangler secret put EMAIL_API_KEY [--env staging]` on both Workers, and `EMAIL_WEBHOOK_SECRET` on the platform Worker (from `platform/`).
2. Move the Plunk workflows' Webhook steps to `/webhooks/email/plunk/<event>`.
3. Send yourself a sign-in link to check mail still goes.
4. Delete the old names: `npx wrangler secret delete PLUNK_SECRET_KEY [--env staging]`, and `PLUNK_WEBHOOK_SECRET` on the platform Worker.
- **Unpausing a camp or changing its limit:** in the console, on the camp's page. With the owner connection instead: `update camp set sending_paused = false where slug = '<slug>'` (or `... set daily_send_cap = <n> ...`).
- **Removing a suppression** (the person fixed their mailbox, or a complaint was a mistake): `delete from email_suppression where email = '<address>'`.
- **Key-date reminders** run on the camp Worker's daily cron (16:00 UTC, `crons.camps` in the instance config).
  - Each run logs `reminder <slug> "<label>": <sent> of <recipients> sent`, or `daily job failed for <slug>: …`.
  - A date already sent has `key_date.reminded_at` set; clearing it sends again on the next run.
- **Discord** (optional): with `DISCORD_WEBHOOK_URL` set, a Discord channel gets a message for every new camp, every sign-up request and every sign-in (camp, role and time; never who).
  - Failures are only logged (`notify:`) and never block anything.
  - Discord allows about 30 messages a minute per webhook; past that, messages are dropped.

## The operator console and Cloudflare Access

The console is at `https://ops.<domain>/ops`. It shows camps with counts and statuses only, never member names, contacts or camp content. From it you:
- set a camp's daily email limit or pause its email;
- suspend or restore a camp, with a reason that's emailed to its Admins and written to its audit log and the operator log;
- create camps and handle sign-up requests;
- handle data requests;
- record emergency database access.

Every console action is in the operator log.

**The console is optional.** Cloudflare Access is the supported way to protect it. An instance that doesn't want one sets `features.console: false`; then `ops.<domain>` answers 404 and the platform Worker serves only the public site, the legal pages and the email webhooks. Its hourly jobs still run. Without the console:
- create camps with `npm run camp:create` (below);
- the sign-up page can't be on (`features.signupPage` needs the console, where requests are decided);
- the rest (email limits, suspensions, data requests) is done with SQL as the owner, and written to `operator_log` by hand.

**Setting up Access** (once per environment; Cloudflare dashboard → Zero Trust):

1. Settings → Custom pages / Team domain: note the team domain, `https://<team>.cloudflareaccess.com`.
2. Settings → Authentication: add a login method that enforces MFA, for example Google or GitHub with two-step verification required on the account. Don't use One-time PIN alone: it isn't MFA.
3. Access → Applications → Add → Self-hosted: domain `ops.<domain>`, session duration 24 hours or less.
4. Policy: Allow, Include "Emails" = the operators' addresses, and add a Require rule for the MFA login method.
5. Copy the application's **Application Audience (AUD) tag**. Put it and the team domain in the instance config (`access.aud`, `access.teamDomain`). They aren't secrets.
6. Add yourself as an operator: `DATABASE_URL=<owner URL> npm run ops:add -- --email you@example.com --name "Your Name"`. The email must match what the login method asserts. `--deactivate` removes access.

## Creating a camp

1. Console → **Camps → New camp**: the camp's name, its address (`<slug>.<domain>`), the first Admin's name and email, and the season it's planning. The default is next year from September on.
   - Addresses are 2 to 40 lowercase letters, digits and single hyphens.
   - System and look-alike names are reserved (`app/lib/reserved-slugs.ts`).
   - An address can't be changed during the pilot.
2. The app creates, in one go:
   - the camp, with dues, the join page and the Yearbook on, and SAPs and jobs off;
   - its season;
   - the first Admin, also Lead and Treasurer, with an invite.

   The invite email comes from `ALERT_MAIL_FROM`. If it didn't send, the console says so, and they can still sign in at the camp's address. On staging, the address must be on the staging allowlist.
3. **Pilot agreement:** the first time an Admin signs in, every page sends them to Admin → Pilot agreement until one of them accepts it for the camp.
   - The acceptance (version, who, when) is in `camp_settings` and the camp's Activity.
   - The text is `legal/<dir>/pilot-agreement.md` (the hosted service's is `legal/hosted/`). If it changes in substance, change `AGREEMENT_VERSION` in `app/lib/data/agreement.server.ts`.
   - An instance without a pilot agreement (config `legal.pilotAgreement: false`) skips this step entirely.
4. **Setup checklist:** Admins and Leads see it on the home page until everything on it is done.

Only camps created this way (`camp.created_in_console`) get the agreement and the checklist.

**From the command line**, with or without the console: the same steps, run with the owner connection. The operator log and the camp's Activity record it as done from the command line.

```sh
DATABASE_URL=<owner URL> EMAIL_API_KEY=<provider key> npm run camp:create -- --instance <name> \
  --name "Dusty Owls" --slug dustyowls --admin "Olive Owl <owl@example.com>" [--admin …] [--year 2027]
```

`--instance` names `config/<name>.json`, for the domain, product name and email provider. Give `--admin` once per first Admin, up to five. Without `EMAIL_API_KEY` the camp is still created, but nobody is emailed. `MAIL_ALLOWLIST` and `DISCORD_WEBHOOK_URL` apply when set, as on the Worker.

## Hosted-only features

The hosted service turns these on, and a self-hosted instance chooses each one in its config's `features` (`app/lib/instance-features.ts`). Each is off unless its setting is `true`:

| Setting | When it's off |
|---|---|
| `signupPage` | `/signup` and `signup.<domain>` answer 404, and the public site doesn't link them. Needs `console`. |
| `feedback` | Camps aren't offered "Send feedback", and `/feedback` answers 404. |
| `usage` | No usage counts are kept (`usage_daily`, `person.last_seen_on`), and the console's Usage page stays empty. |
| `discord` | Nothing is posted to Discord, even if `DISCORD_WEBHOOK_URL` is set. |
| `console` | See The operator console, above. |

The legal templates (`legal/templates/`) mention a feature only when it's on: a line ending in `{feature:<name>}` is dropped when that feature is off, and the tag is removed when it's on.

**The icon** (favicon and apple-touch icon) is `icons/<product.icon>/`. The hosted service's is the TCA icon in `icons/hosted`; `icons/default` is a neutral tent. Make one from initials with `npx tsx scripts/make-icon.ts --initials EC --name <folder>` (optionally `--bg` and `--fg`), then set `product.icon` to the folder. Both Workers serve it at `/favicon.ico` and `/apple-touch-icon.png`.

## Single-camp instances

An instance for one camp sets `singleCamp: { "slug": "<slug>", "host": "<host>" }` in its config. The host is the domain itself (`example.org`) or a name under it (`camp.example.org`). Then:
- the camp Worker answers only for that host. Every other host gets the "couldn't find that camp" page, including `<slug>.<domain>`;
- the platform Worker is deployed with **no routes**, only its hourly jobs: deletions, exports, support grants, usage and the health check. So `features.console` and `features.signupPage` must be off, and the config check refuses them;
- the legal pages are served by the camp Worker at `<host>/legal/<doc>`, since there's no public site;
- the email provider's bounce and complaint webhooks have nowhere to go, because they're on the platform Worker's public host. Rely on the provider's own suppression for now.

Create the camp once, with the same slug: `npm run camp:create -- --instance <name> --slug <slug> …` (Creating a camp, above).

## Sign-up requests

- **The link to give camps:** `https://signup.<domain>`, which redirects to `<domain>/signup`.
  - It's protected by its own Turnstile widget, and 5 submissions a minute per IP address.
  - Until the platform Worker has `TURNSTILE_SECRET`, the page says sign-ups aren't open.
- **Each request:** a Discord message (camp name and number of organizers only) and a count on the console's **Sign-ups** tab. Nothing is emailed to the camp until you decide.
- **Approve:** open the request, correct anything, and approve. That runs the same creation as **New camp**: every listed organizer becomes an Admin, Lead and Treasurer and gets an invite. If creation fails (say the address is taken), the request goes back to waiting.
- **Decline:** optionally with a message, which is then emailed to the organizers. Without one, nothing is sent.
- **Cleanup:** decided requests are deleted after 90 days (the hourly `expire_signups` job).

## The public site and the demo camp

- **The public site** is the platform Worker's apex: a landing page and `/legal/{terms,privacy,data-handling}`, plus `/legal/pilot-agreement` where the instance has one. They're rendered from `legal/<dir>/*.md`, where `<dir>` is the instance config's `legal.dir`: the hosted service's own documents are `legal/hosted/`, and `legal/templates/` are examples for self-hosters, to adapt with their own lawyer. `{product}`, `{operator}` and `{contact}` in them are filled in from config.
- **`CONTACT_EMAIL`** is the contact and abuse address, so it must receive mail. Cloudflare Email Routing can forward it.
- **The demo camp** is `demo.<domain>`, a camp of kind `demo` that never saves anything (`docs/architecture.md`). Seed or reset it every few months, since its dates are relative to today:

  ```sh
  DATABASE_URL="$OWNER" npm run demo:seed                             # the demo camp, no files
  DATABASE_URL="$OWNER" npm run demo:seed -- --bucket <bucket>        # also uploads its files
  ```

  - It deletes and recreates the demo camp, keeping its id, and refuses to touch a camp that isn't a demo.
  - With `--bucket` (Wrangler logged in), it uploads the demo's avatars and a sample Setup Access Pass, under fixed keys, so a re-run overwrites them.

## Alerts

**Hourly, at :07,** the platform Worker runs its jobs, then the health check. It emails `OPERATOR_EMAIL` from `ALERT_MAIL_FROM` when:

| Alert | When | What to do |
|---|---|---|
| Email paused for `<slug>` | the bounce/complaint webhook paused the camp's sending | Find out why (the provider's activity log, `send_log`), then unpause it |
| Email failing for `<slug>` | over 20% of its last hour's sends failed (10 sends at least) | Check the provider's status and the camp's `send_log.error` |
| Sign-in failures at `<slug>` | 10 or more failed sign-ins in the last hour | The camp's Admin → Sign-in log shows the steps; a broken link or email is the usual cause |
| Scheduled job `<name>` failed | a job threw this hour | Workers Logs for the platform Worker; it retries next hour |
| Camp isolation problem | the isolation probe saw another camp's rows | **An incident.** See Incidents |

- **Once a day at most:** a problem is emailed when first seen, then again every 24 hours while it lasts. `delete from platform_alert` makes every current problem email again next hour.
- **A failed alert email** isn't recorded, so it's tried again next hour.
- **Worker errors (5xx) aren't in these alerts.** Both Workers have Workers Logs on: dashboard → Workers → the Worker → Logs, filtered to errors. Check them when a camp reports trouble, and weekly during the pilot.

**The daily isolation probe** (`.github/workflows/isolation-probe.yml`, 08:37 UTC) runs `npm run probe:isolation` against each environment as `app_probe`, a login role that can only read camp tables. GitHub emails you when it fails. An environment without `PROBE_DATABASE_URL` is skipped with a notice. To set it up, once per environment:

```sh
OWNER=$(neonctl connection-string --project-id <project> --role-name neondb_owner --database-name neondb)
PB=$(openssl rand -hex 24)
DATABASE_URL="$OWNER" APP_PROBE_PASSWORD="$PB" npm run db:roles    # creates app_probe
DATABASE_URL="$OWNER" npm run db:grants                              # gives it read on camp tables
node -e 'const u=new URL(process.argv[1]); u.username="app_probe"; u.password=process.argv[2]; console.log(u.toString())' "$OWNER" "$PB" \
  | gh secret set PROBE_DATABASE_URL --env <staging|production>
```

Optionally set the environment variable `PROBE_CAMP_ID` to a real camp's id, so the probe also checks that one camp sees no other camp's rows. Then run the workflow by hand once (Actions → Isolation probe → Run workflow).

## Incidents

1. **Isolation problem** (a camp could see another camp's rows):
   - **Fix it first.** The probe names the table; `select enable_camp_rls('<table>')` as the owner restores the standard policy. The next hourly check, or a manual run of the Isolation probe workflow, should come back clean. Suspending a camp doesn't help: it stops changes, not viewing.
   - **Then work out what was exposed.** The audit log records changes and support views, not members' page views, so assume anyone signed in during the window could have seen the rows the probe named.
   - **Tell the affected camps' Admins,** and record the owner access as emergency database access in the console.
2. **Email paused or failing:** leave it paused until you know why. A camp that keeps bouncing needs its list cleaned, not a higher limit.
3. **The app is down or erroring:** check Workers Logs first, then Neon's status and Hyperdrive. Roll back by redeploying the last good commit. After a bad migration, restore from the `pre-migration-<sha>` branch (Restore).
4. **Afterwards:** write a short note on what happened and what changed.

## Data requests

Someone asks, usually by email, for a full export of their camp, for their camp to be deleted, or for their login to be deleted. Nothing is done on the asking alone:

1. Console → **Data requests** → record it: the camp, what was asked, and the requester's email. Exports and camp deletions must come from one of the camp's active Admins; a login deletion from the person themselves.
2. They get an email with a link on their camp's site. Opening it shows what was asked, and pressing the button confirms. The link lasts 7 days.
3. Once it says **Confirmed**, carry it out from the same page:
   - **Export:** the camp must also have granted support access, since you'll be looking at its data.
     - The zip appears at Admin → Exports for the camp's Admins for 7 days, and is never emailed.
     - A camp with more than 60 MB of files is refused, since the zip is built in the Worker's memory. Export it by hand instead (the tables with `psql` as the owner, the files from R2 under `camps/<camp id>/`), and share it the same way.
   - **Delete the camp:** it closes at once and is deleted for good 30 days later by the hourly job. Until then, **Restore the camp** on its console page.
   - **Delete the login:** the login goes, and the person becomes "a deleted member" in every camp they were in. This can't be undone.

## Support access

- **The operator sees a camp's data only while one of its Admins has granted support access** (Admin → Support access: 1 hour, 1 day, 3 days or 7 days). It's read-only.
- **To open a camp:** console → the camp → "Open the camp (read-only)". Leave with "Leave support view" in the camp's header.
- **What the Admins see:** a banner while access runs. Every page you open is in their Activity, and they're emailed when it starts and ends.
- **If you're also a member of the camp,** the support view takes over while its cookie is set. Leave it to be yourself again.
- **Nothing lets the operator into a camp without a grant.** If a camp needs a fix, walk its Admin through it, or ask for a grant to look first.

## Sign-in email changes

- A member changes their sign-in email on their profile in two steps: their **current** address approves, then the **new** address confirms. Once confirmed, the login's email changes in every camp, and they're signed out everywhere.
- **Lost the old mailbox?**
  - Someone who can manage people unlinks their login on their person page, fixes the email, and re-invites them.
  - For someone with more access, only a person with at least that access can.

## Security fixes

Reports arrive privately (`SECURITY.md`): through GitHub's private vulnerability reporting, or by email to the contact address. Reply within 3 working days. Then:

1. Open a private security advisory for it, and develop the fix in the advisory's temporary private fork, with a test that fails without it.
2. **Deploy the fix to the hosted service first,** by hand from that fork with your own credentials: the migrations and `db:grants` if any, then `npm run deploy` (Deploys, "By hand"). The workflows only deploy from the canonical repository. **This is the one exception to deploying production only from a release:** for a few days, production runs a build ahead of the public tag.
3. Merge the fix, tag a release, and publish the advisory. Its notes tell self-hosters to upgrade, and the advisory notifies everyone watching the repository's security advisories. Announce it on the Discord server too.

## Snapshots, backups and restores

- **Snapshots:** every production deploy saves the database before migrating, the way the instance config's `database.snapshot` says:
  - `neon` (the hosted service): a Neon branch `pre-migration-<sha>` (`scripts/neon-snapshot.sh`, with `NEON_API_KEY` and `NEON_PROJECT_ID`), keeping the newest 3;
  - `dump` (any Postgres): an encrypted `pg_dump` (`scripts/db-dump.sh`, to `AGE_PUBLIC_KEY`), kept 30 days as the workflow artifact `pre-migration-<sha>`;
  - `none`: no snapshot. Staging uses it: it holds only fictional data.
- **Backups:** `.github/workflows/backup.yml` dumps production daily (09:17 UTC) with `scripts/db-dump.sh`, encrypts it with `age` to `AGE_PUBLIC_KEY`, and keeps it 90 days as a workflow artifact named `tca-backup-<stamp>`. It runs while `BACKUPS_ENABLED=true`. The dump works on any PostgreSQL 16 or newer; its client is PostgreSQL 18 (`.github/actions/pg-client`), since `pg_dump` must be at least as new as the server.
- **Key custody:**

  ```sh
  age-keygen -o tca-backup.key                            # prints the public key
  age-keygen -y tca-backup.key | gh secret set AGE_PUBLIC_KEY --env production
  ```

  Keep `tca-backup.key` in a password manager, then delete it from disk. Without it, no backup can be read.
- **Retention:** daily dumps 90 days, pre-migration dumps 30; Neon history and snapshots on Neon's windows. After any restore, delete again every camp whose deletion was finalized since that backup.

**Restoring:**

- **Bad data, recent:** Neon point-in-time restore on the production branch.
- **After a bad migration:** restore from `pre-migration-<sha>` (the Neon branch, or the dump artifact as below), then redeploy the previous commit.
- **From a dump:** `age -d -i tca-backup.key tca-<stamp>.dump.age > tca.dump`, then `pg_restore --no-owner --clean --if-exists -d "$OWNER_URL" tca.dump` with a PostgreSQL 18 client. Rehearse with the drill first.
- **Restore drill**, every few months: `DATABASE_URL=<owner URL> scripts/restore-drill.sh tca-backup.key [dump file]` (needs docker, `age`, and a logged-in `gh` to fetch the newest backup when no file is given). It restores into a throwaway PostgreSQL 18 container (`PG_MAJOR` for another) and compares every table's row count with `DATABASE_URL`. Rehearse a Neon point-in-time restore too:
  - `neonctl branches create --project-id <project> --name pitr-drill-<date> --parent <ISO time>` (a bare timestamp means the default branch);
  - spot-check its counts;
  - delete it.

**Restore drill log (hosted service):**

| Date | What was restored | Result |
|---|---|---|
| 2026-10-01 | The first backup, `tca-20261001T2121Z`, decrypted and restored into a throwaway PostgreSQL 18 container with `scripts/restore-drill.sh` | Passed: 13 tables match production |
| 2026-10-01 | Neon point-in-time restore: a branch from production at 21:07:06 UTC (`--parent <timestamp>`; `production@<time>` isn't accepted) | Passed: counts match production; branch deleted |

## Secrets inventory

Nothing secret is ever committed. Staging and production share no secrets, except the email provider's key, below.

| Secret | Where | Environments | Rotation |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Actions (`staging`, `production` environments) | both | On exposure. Scope: account Workers Scripts Edit; zone Workers Routes Edit on the instance's zones only |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions | both | Not secret |
| `BETTER_AUTH_SECRET` | camp Worker secret | each its own | Rotating signs everyone out: `openssl rand -base64 48 \| tr -d '\n' \| npx wrangler secret put BETTER_AUTH_SECRET [--env staging]` |
| `EMAIL_API_KEY` (was `PLUNK_SECRET_KEY`) | camp and platform Worker secrets | the hosted service shares one Plunk project between environments | On exposure: regenerate it with the provider, then put the new one on both Workers |
| `EMAIL_WEBHOOK_SECRET` (was `PLUNK_WEBHOOK_SECRET`) | platform Worker secret | each its own; 32+ random characters, also in the provider's webhook headers | On exposure: put a new one on the Worker, then update the provider's webhooks |
| `OPERATOR_EMAIL` | platform Worker secret | both | When it changes; it's where alerts go |
| `DISCORD_WEBHOOK_URL` | camp and platform Worker secret (optional) | production | On exposure: delete the webhook in Discord, create a new one, put it on both Workers |
| `TURNSTILE_SECRET` | camp Worker secret; the platform Worker has its own for the sign-up widget | each its own | On exposure: rotate it in the dashboard (Turnstile → the widget), then put the new one on the Worker |
| Role passwords (`app_runtime`, `app_platform`) | Hyperdrive only | each its own | See Database roles and grants |
| `DATABASE_URL` (owner, direct) | GitHub Actions | each its own | On exposure: reset the owner password in Neon, then `neonctl connection-string ... \| gh secret set DATABASE_URL --env <env>` |
| `NEON_API_KEY` | GitHub Actions `production` (snapshots) | production | On exposure |
| `NEON_PROJECT_ID` | GitHub Actions `production` | production | Not secret |
| `PROBE_DATABASE_URL` | GitHub Actions | each its own; `app_probe` only | On exposure: re-run the probe setup with a new password |
| `AGE_PUBLIC_KEY` | GitHub Actions `production` | production | A public key; the private key is offline. Replace if the private key is lost or exposed |

## Local development and tests

- Tests use their own Postgres 18 container on port **54339**:

  ```sh
  docker run -d --name tca-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 54339:5432 postgres:18-alpine
  ```

- `npm test` builds both Workers once, then runs every test file against a throwaway database. Request tests run the real bundles in workerd.
- `npm run dev` (camps) and `npm run dev:platform` use the same container through Hyperdrive's local connection string.
- **Never point local dev or tests at a hosted database.**
- **Adding a route?** Add its probes to `tests/authz/cross-camp.registry.ts`: camp A's Admin aimed at camp B's records must see no camp B data, change nothing of camp B's, and get a 404 wherever the URL names a camp B record. CI fails if a route has no entry.
- **Isolation probe by hand:** `PROBE_DATABASE_URL=<app_runtime URL> [PROBE_CAMP_ID=<uuid>] npm run probe:isolation` checks every camp table under row-level security, read-only.
