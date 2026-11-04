# Running your own Theme Camp App

This guide takes you from a fork of this repository to a running instance: one camp at its own address, or many camps at `<camp>.<your domain>`. It assumes you're comfortable with a terminal, Git and DNS. Plan on an afternoon.

How the instance is run after that (alerts, incidents, data requests, restores) is in [`docs/operating.md`](operating.md). How the pieces fit together is in [`docs/architecture.md`](architecture.md).

**The short way:** after steps 1, 3 and 4's owner role below, `DATABASE_URL=<owner URL> npm run setup` asks a few questions, then does steps 2 and 4 to 9 for you: the config, the database roles and migrations, Hyperdrive and R2, the deploy, the secrets and the first camp. `npm run setup -- --dry-run` shows what it would do without doing it. It's safe to re-run. It can't do DNS, the Turnstile widgets (it asks for their keys), your email provider's account and webhook, or Cloudflare Access. The steps below are what it does, for when you'd rather do them by hand or something goes wrong.

**With an AI agent:** [`docs/self-hosting-agent-prompt.md`](self-hosting-agent-prompt.md) is a prompt for Claude Code, Codex or similar, with blanks for your answers. The agent follows this guide, asks before anything that costs money or emails people, and never sees your secrets.

## What you need, and what it costs

Prices were checked on 2026-10-15. They change, so check each provider's page before you commit.

| Service | What it's for | Cost |
|---|---|---|
| **Cloudflare** (a domain on it, and Workers) | Runs the app, stores photos and files (R2), and resizes photos (Images) | **Workers Paid, $5 a month.** It includes Hyperdrive, which the app needs to reach Postgres. R2's free tier (10 GB) and Images' 5,000 free transformations a month cover a typical camp. |
| **Postgres 16 or newer** | The database | Neon's free plan (1 GB per project) is enough for several camps. Any host works: Supabase, RDS, your own server. |
| **An email provider:** Postmark or Plunk | Sign-in links, invites, reminders | **Postmark's free plan is 100 emails a month**, which a camp of 150 outgrows the first time it sends a reminder. Count on the smallest paid plan, $15 a month for 10,000 emails. |
| **GitHub** | The code, CI and the deploy workflows | Free |

**Email is the one cost that grows with your camps:** every reminder goes to every member. Everything else stays at Cloudflare's $5 for a long time.

## 1. Fork and set up locally

```sh
git clone https://github.com/<you>/themecampapp && cd themecampapp
npm install
docker run -d --name tca-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test -p 54339:5432 postgres:18-alpine
npm run check        # typecheck, lint and the full test suite
```

If the tests pass, your machine is ready.

## 2. Write your instance's config

Every setting that differs between instances is in one file, `config/<name>.json`. Copy the template and fill it in:

```sh
cp config/example.json config/mine.json
```

`config/schema.ts` explains every field. The ones to decide now:

- **`domain`:** your domain, on Cloudflare. A multi-camp instance serves camps at `<slug>.<domain>` and its public site at the domain itself.
- **`singleCamp`:** `null` for many camps. For one camp, `{ "slug": "dustyowls", "host": "camp.example.org" }`. The host is the domain itself or a name under it. See "Single-camp instances" in `docs/operating.md` for what changes.
- **`workers`, `bucket`:** names for your two Workers and your R2 bucket.
- **`product`:** what your instance is called, who runs it, a contact address that receives mail, its icon (`npx tsx scripts/make-icon.ts --initials EC --name mine` draws one), and `sourceUrl`, where its source code is. Every page links to it, because the AGPL (section 13) has you offer your instance's source to the people who use it. Leave it at the public repository while you run the code unchanged, and point it at your own fork once you change anything.
- **`mail`:** `postmark` or `plunk`, and the addresses mail comes from.
- **`features`:** the hosted service's own pieces: the public sign-up page, the operator console, in-app feedback to you, usage counts and Discord notices. The template turns them all off. A single-camp instance must keep `console` and `signupPage` off. See "Hosted-only features" in `docs/operating.md`.
- **`legal`:** `templates` uses the example legal pages in `legal/templates/`. They're a starting point, not legal advice. Copy them to `legal/<yours>/`, fill in every `[square bracket]` with your own lawyer, and point `legal.dir` at the copy. Turn `pilotAgreement` off unless you want one.
- **`database.snapshot`:** `dump` for any Postgres (an encrypted `pg_dump` before each migration), `neon` if you're on Neon and want branches instead, or `none`.

Nothing in the config is secret. Commit it. You'll fill in the Cloudflare ids (Hyperdrive, Turnstile, rate limits) as you create them below.

## 3. DNS

On your domain's zone in Cloudflare, add proxied records so the Workers' routes receive traffic:

| Instance | Records (all proxied) |
|---|---|
| Many camps | `AAAA @ 100::` and `AAAA * 100::` |
| One camp | `AAAA <host> 100::` for the camp's host (`@` if it's the domain itself) |

Cloudflare's free certificates cover the domain and one level of names under it, so camps at `<slug>.<domain>` are covered.

## 4. The database

Any Postgres 16 or newer works, without a superuser. Make an owner role and a database once, as whoever administers the server (on Neon, the project's `neondb_owner` already is one):

```sql
create role tca_owner login createrole bypassrls password '<32+ random characters>';
create database tca owner tca_owner;
```

Then, with `DATABASE_URL` set to the owner's connection (direct, not pooled), create the app's roles, run the migrations and apply the grants:

```sh
export DATABASE_URL='postgres://tca_owner:…@host:5432/tca'
export APP_RUNTIME_PASSWORD=$(openssl rand -hex 24) APP_PLATFORM_PASSWORD=$(openssl rand -hex 24)
echo "$APP_RUNTIME_PASSWORD $APP_PLATFORM_PASSWORD"     # keep these for step 5
npm run db:roles
npx drizzle-kit migrate
npm run db:grants
```

Keep the two passwords for the next step: they go into Hyperdrive and nowhere else. "Database roles and grants" in `docs/operating.md` explains each role. **On Neon, create roles only this way**, never in Neon's console: console-made roles bypass row-level security.

### On Neon

Neon is what the hosted service runs on, and its free plan is enough to start. What changes in steps 4, 5 and 11:

1. **Create a project** in the Neon console, on Postgres 18 (what CI tests most), in the region you'll use for `placementRegion`: Neon's `aws-us-west-2` is `aws:us-west-2`. Skip the owner role above: the project's `neondb_owner` already is one, and its database is `neondb`.
2. **The owner URL** must be the direct one, not the pooled one (whose host has `-pooler` in it). With `neonctl` (`npm i -g neonctl`, then `neonctl auth`), the default is direct:

   ```sh
   export DATABASE_URL=$(neonctl connection-string --project-id <project id> \
     --role-name neondb_owner --database-name neondb)
   ```

   Then run the role, migration and grant commands above.
3. **Hyperdrive** (step 5) connects to the same direct host as each Worker's role: `postgres://app_runtime:<runtime password>@<the host from the owner URL>/neondb`, and the same for `app_platform`. Hyperdrive does the pooling, so Neon's pooler adds nothing.
4. **Snapshots:** set `database.snapshot` to `neon` (the setup script writes `dump`). Each production deploy then makes a `pre-migration-<commit>` branch first and keeps the newest 3. It needs two secrets in the `production` environment (step 11): `NEON_API_KEY` (Neon console → account settings → API keys) and `NEON_PROJECT_ID` (project settings). Point-in-time restore covers recent mistakes, within your plan's history window.
5. **Staging,** if you have one, gets its own Neon project, so it shares nothing with production.

**Expect a slow first page after a quiet spell.** Neon's free plan suspends the database after a few idle minutes and wakes it on the next connection, which adds a moment to that request. Paid plans can keep it awake.

## 5. Cloudflare resources

Log in with `npx wrangler login`, then create:

1. **Two Hyperdrive configs**, one per Worker, each connecting as its own role, **with caching off**:

   ```sh
   npx wrangler hyperdrive create mine-camps --caching-disabled \
     --connection-string='postgres://app_runtime:<runtime password>@host:5432/tca'
   npx wrangler hyperdrive create mine-platform --caching-disabled \
     --connection-string='postgres://app_platform:<platform password>@host:5432/tca'
   ```

   Put the ids in `hyperdrive.camps` and `hyperdrive.platform`.
2. **An R2 bucket:** `npx wrangler r2 bucket create <bucket>`. It stays private, since the Workers serve its files.
3. **Two Turnstile widgets** (dashboard → Turnstile): one for the camps' join pages (hostname: your domain, which covers its subdomains) and one for the sign-up page. Put the site keys in `turnstile.camps` and `turnstile.signup`, and keep the secrets for step 6. If you have no sign-up page, use the same widget for both.
4. **Rate limits:** `rateLimits.join` and `rateLimits.signup` are any two numbers unique in your Cloudflare account (for example `1001` and `1002`). There's nothing to create.
5. **`placementRegion`:** the cloud region nearest your database (for example `aws:us-east-1`). Both Workers run there, since each page makes several round trips to Postgres.
6. **The operator console** (only with `features.console`): protect `ops.<domain>` with Cloudflare Access, as in "The operator console and Cloudflare Access" in `docs/operating.md`, and fill in `access`.

Then generate the Workers' Wrangler configs from your instance config:

```sh
npx tsx scripts/config-to-wrangler.ts --out-dir . mine
```

## 6. Email

With Postmark:

1. Create a server, and verify your sending domains (`mail.from`, `mail.authFrom`, `mail.alertFrom`) with SPF and DKIM.
2. Its **Server API token** is `EMAIL_API_KEY`.
3. Add the bounce and complaint webhook on the `outbound` stream: `https://<domain>/webhooks/email/postmark`, with the header `Authorization: Bearer <EMAIL_WEBHOOK_SECRET>`, for Bounce and Spam Complaint.

The webhook lets the app stop mailing addresses that bounce, and pause a camp whose mail is bouncing. A single-camp instance has no route for it yet, so there Postmark's own suppression does the job. Plunk's setup is in "Email" in `docs/operating.md`.

## 7. Secrets

Put each secret on the Worker that needs it with `npx wrangler secret put <NAME>`, run from the repository root for the camp Worker and from `platform/` for the platform Worker:

| Secret | Worker | What it is |
|---|---|---|
| `BETTER_AUTH_SECRET` | camp | Signs sessions. `openssl rand -base64 48`. Changing it signs everyone out. |
| `EMAIL_API_KEY` | both | The email provider's key (step 6) |
| `EMAIL_WEBHOOK_SECRET` | platform | 32+ random characters, also in the webhook's header |
| `OPERATOR_EMAIL` | platform | Where the hourly health alerts go: you |
| `TURNSTILE_SECRET` | both | Each Worker's own widget's secret (step 5) |
| `DISCORD_WEBHOOK_URL` | both, optional | Only with `features.discord` |

The database passwords live only in Hyperdrive.

## 8. The first deploy

```sh
npm run build
npx tsx scripts/check-deploy-target.ts mine
npx wrangler deploy && (cd platform && npx wrangler deploy)
```

`check-deploy-target` refuses to continue if the build would deploy anywhere but your instance's Workers and zone. After this first deploy, the workflows in step 11 can do it for you.

## 9. The first camp

Create it from the command line, with the same slug as `singleCamp.slug` if you have one camp:

```sh
DATABASE_URL=<owner URL> EMAIL_API_KEY=<key> npm run camp:create -- --instance mine \
  --name "Dusty Owls" --slug dustyowls --admin "Olive Owl <owl@example.com>"
```

The Admin gets an email with a link to sign in. From there, the camp's setup checklist walks them through the rest. With the console on, add yourself as an operator (`npm run ops:add`) and create camps there instead.

## 10. Backups, monitoring and bounces

- **Backups:** `.github/workflows/backup.yml` dumps the database daily, encrypted with `age`, and keeps 90 days as workflow artifacts. Set it up (the key, `AGE_PUBLIC_KEY`, `BACKUPS_ENABLED`) as in "Snapshots, backups and restores" in `docs/operating.md`, and run a **restore drill** (`scripts/restore-drill.sh`) once it has a backup. A backup you've never restored isn't a backup yet.
- **Health alerts:** the platform Worker checks hourly and emails `OPERATOR_EMAIL` about paused or failing email, sign-in trouble, failed jobs and isolation problems ("Alerts" in `docs/operating.md`).
- **The isolation probe:** `.github/workflows/isolation-probe.yml` checks daily that no camp can see another's rows, as a read-only role. Set up `PROBE_DATABASE_URL` as in "Alerts".
- **When email bounces:** the app stops mailing that address, and pauses a camp's sending if too much of it bounces. The alert says which camp. The fixes (unpausing, removing a suppression) are in "Email" in `docs/operating.md`.

## 11. Deploying from GitHub

The repository's workflows deploy your instance from your fork, doing what the hosted service's pipeline does: check CI, snapshot the database, migrate, apply grants, build, check the target, deploy.

1. **Repository variables** (Settings → Secrets and variables → Actions → Variables):
   - `DEPLOY_INSTANCE`: your config's name (`mine`). Until it's set, your fork's workflows run CI and deploy nothing.
   - `STAGING_INSTANCE`: a second config for a staging copy, or `none` for no staging. Staging deploys only once both are set. A staging config with its own `wranglerEnv` (like `config/staging.json`) is built as a Wrangler environment of the first. One with `wranglerEnv: null` is deployed on its own, so give it different Worker names.
2. **Environments** (Settings → Environments): `production`, and `staging` if you have one. Require your approval for `production`.
3. **Secrets** in each environment:
   - `CLOUDFLARE_API_TOKEN`, with Workers Scripts Edit on the account and Workers Routes Edit on the zone;
   - `CLOUDFLARE_ACCOUNT_ID`;
   - `DATABASE_URL`, the owner connection;
   - `AGE_PUBLIC_KEY` for `dump` snapshots and backups;
   - `NEON_API_KEY` and `NEON_PROJECT_ID` for `neon` snapshots;
   - `PROBE_DATABASE_URL` for the isolation probe.
4. **Run it:** every push to `main` runs CI and then deploys staging. Production is **Actions → Deploy production → Run workflow** on `main`, which refuses a commit whose CI didn't pass. (The hosted service's own repository deploys release tags instead; your fork deploys `main`.)

The `CI_RUNNER` variable picks a self-hosted runner for pull requests. Leave it unset on a public repository: anyone's pull request would run code on that machine.

## Privacy: your role

The people in your camps trust **you** with their details, not the hosted service. Nothing in your instance reports to themecamp.app or to us: its usage counts, feedback, alerts and Discord notices all go to you, and only when you turn them on.

- **Running it for your own camp:** your camp decides what it keeps and who sees it, so it's responsible for that data (the "controller", in GDPR's terms). Your Privacy Policy says so.
- **Running it for other camps:** like the hosted service, each camp decides what it keeps about its people, and you store and process it for them. `legal/templates/privacy.md` is written that way. Some camps may want a written agreement with you about it.
- **Either way, what the app stores** is listed in the template's "What's stored" section, and how long it's kept in "How long it's kept". Check both against your settings (the hosted-only features add or remove lines), and against any changes you make to the code.
- **Your providers** (Cloudflare, your database host, your email provider, where your backups go) handle the data for you. Name them in your Privacy Policy, as the template's "Who else handles it" does.
- **Requests from people** (a copy of their data, deleting their login, deleting a camp) are handled as in "Data requests" in `docs/operating.md`.

## Upgrading

[`docs/upgrading.md`](upgrading.md) covers it: `scripts/upgrade.ts` shows what a release brings, then the workflows deploy it.

## The Burning Man API

The hosted service may connect to Burning Man's systems under its own agreement with Burning Man. Those keys can't be shared with other instances. An instance that wants the integration needs its own agreement and keys from Burning Man.
