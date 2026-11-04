# Setting up with an AI agent

A coding agent like Claude Code or Codex can follow [`self-hosting.md`](self-hosting.md) for you: write the config, run the setup, check every step, and tell you what to click where it can't do something itself. Below is a prompt to start it with. Fill in the `{{placeholders}}`, do the few things in "Before you start" yourself, then paste the prompt into an agent running at the root of your fork.

The prompt is written so that **secrets never pass through the agent**: anything secret is typed into your own terminal, never into the chat. It also has the agent ask before anything that costs money, can't be undone or emails people. Keep those rules in the prompt even if you change the rest.

## Before you start

These need you: a browser, an account or a secret.

1. **Accounts:** a Cloudflare account with your domain on it and Workers Paid; a Postgres 16+ server; an email provider (Postmark or Plunk). "What you need, and what it costs" in `self-hosting.md` has the prices.
2. **Your fork**, cloned, with `npm install` run in it.
3. **Cloudflare login:** `npx wrangler login` in the fork.
4. **The database's owner role** (step 4 of `self-hosting.md`, the SQL part). Then put its connection in your shell, in the window you'll start the agent from, so the agent can use it without seeing it:

   ```sh
   read -rs DATABASE_URL && export DATABASE_URL     # paste the owner URL (direct, not pooled), then Enter
   ```
5. **Two Turnstile widgets** (Cloudflare dashboard → Turnstile; step 5.3). The site keys go in the prompt. Keep the secret keys for the setup, which asks for them in your terminal.

## The prompt

Lines you don't need can go (for example, the single-camp line on an instance with many camps). Optional ones say what happens when they're left out.

```text
You're setting up a self-hosted instance of Theme Camp App from this repository, which is my fork.
docs/self-hosting.md is the authority: read it in full before doing anything, and the sections of
docs/operating.md it points to when you reach them. If this prompt and the guide disagree, or the
guide doesn't match what you find, stop and ask me. If any {{placeholder}} below is still unfilled,
ask me for it before you start.

## My instance

- Config name (config/<name>.json; letters, digits, hyphens): {{INSTANCE_NAME}}
- Domain, already on my Cloudflare account: {{DOMAIN}}
- Camps: {{ONE_OR_MANY}}
  ("many": camps at <slug>.{{DOMAIN}} and a public site at {{DOMAIN}}. "one": a single camp.)
- For one camp only, its slug and host: {{CAMP_SLUG}}, {{CAMP_HOST}}
- What the instance is called: {{PRODUCT_NAME}}
- Who runs it (named in the legal pages and emails): {{OPERATOR_NAME}}
- A contact address that receives mail: {{CONTACT_EMAIL}}
- Icon: {{ICON}}
  (initials to draw one with scripts/make-icon.ts, such as "DO", or "default" for the neutral tent)
- Email provider: {{EMAIL_PROVIDER}} (postmark or plunk)
- Sending addresses, or "defaults" for notify@mail.{{DOMAIN}} and signin@auth.{{DOMAIN}}:
  from {{MAIL_FROM}}, sign-in links from {{MAIL_AUTH_FROM}}, alerts from {{MAIL_ALERT_FROM}}
- Where the database runs: {{DATABASE_HOST}} (Neon, Supabase, RDS, my own server…)
- Snapshots before each migration: {{SNAPSHOT}} (dump, neon or none)
- The cloud region nearest the database: {{PLACEMENT_REGION}} (for example aws:us-east-1)
- Turnstile site keys (not secret): join pages {{TURNSTILE_CAMPS_SITE_KEY}},
  sign-up page {{TURNSTILE_SIGNUP_SITE_KEY}} (or the same key)
- Hosted-only features to turn on: {{FEATURES}}
  (none, or any of signupPage, console, feedback, usage, discord. A single-camp instance keeps
  console and signupPage off. The console also needs Cloudflare Access, which I'll set up.)
- Legal pages: {{LEGAL}}
  (for example: "copy legal/templates/ to legal/{{INSTANCE_NAME}}/, fill in the facts you know
  from this list, and list every [bracket] left for me and my lawyer". Never present your edits
  as legal advice.)
- First camp: {{FIRST_CAMP_NAME}}, slug {{FIRST_CAMP_SLUG}},
  first Admin {{FIRST_ADMIN_NAME}} <{{FIRST_ADMIN_EMAIL}}>
- Deploy from GitHub Actions afterwards: {{GITHUB_DEPLOYS}} (yes or no; my fork is {{FORK_URL}})
- Staging: {{STAGING}} (none, or a second domain for a staging copy)
- Daily encrypted backups: {{BACKUPS}} (yes or no)

## Already done

- The fork is cloned and npm install has run.
- npx wrangler login has run.
- DATABASE_URL is set in your environment to the database owner's connection. Use it only as
  "$DATABASE_URL". Never print it, echo it or write it to a file.
- The Turnstile widgets exist. Their site keys are above, and I have their secrets.

## Rules

1. Secrets never pass through you. Don't ask me to paste one into the chat, and never print, log,
   write or commit one. The secrets are the email API key, the webhook secret, the Turnstile
   secrets, BETTER_AUTH_SECRET, the database passwords, Cloudflare API tokens and the backup key.
   When a command needs one typed in, give me the exact command to run in my own terminal window
   (not through you: its output would land in this conversation), then wait for me to say it's
   done.
2. Ask before anything that costs money, can't easily be undone, or reaches people: creating
   Cloudflare resources, changing the database, deploying, creating a camp (it emails the Admin),
   pushing, and changing GitHub settings. Show me the command and say what it does, then wait.
   Reading files, `npm run check`, dry runs and checking what exists don't need asking.
3. Change only my instance's own files: config/{{INSTANCE_NAME}}.json, legal/{{INSTANCE_NAME}}/
   and icons/{{INSTANCE_NAME}}/. Don't change the app's code, migrations, workflows, tests or
   the other configs. If something seems to need that, stop and tell me what and why.
4. When something fails, stop. Show me the error and what you think it means. Never work around a
   safety check (check-deploy-target, the database grants check, CI): they keep camps' data apart.
5. Where a step needs a dashboard (DNS, the email provider, Cloudflare Access, GitHub
   environments), tell me exactly what to enter, then check the result yourself where you can
   (dig, curl, gh, wrangler).

## The order

1. Check the ground: Node 22, `npx wrangler whoami`, that DATABASE_URL is set (without showing
   it), and `npm run check` (step 1 of the guide has the test database's docker command).
2. Write config/{{INSTANCE_NAME}}.json from config/example.json, as in step 2, from my answers.
   Leave the Hyperdrive ids as the template's <placeholders>: the setup fills them in. Make the
   icon and the legal pages too. Check the config with
   `npx tsx scripts/config-to-wrangler.ts --out-dir "$(mktemp -d)" {{INSTANCE_NAME}}`, then show
   it to me and wait.
3. DNS (step 3): tell me the records, then check them with dig.
4. Write an answers file for `npm run setup` outside the repository (the shape is `Answers` in
   scripts/setup.ts), with firstCamp null: the first camp waits until email works. The setup
   reuses the config you wrote. Run `npm run setup -- --answers <file> --dry-run`, and show me
   what it will do. (The bounce webhook secret the dry run prints is made up and never used.)
5. Give me the real `npm run setup -- --answers <file>` to run in my terminal. It asks there for
   the email API key, the Turnstile secrets and the alert address, and prints the bounce
   webhook's secret for me to keep. When I say it's done, check what it made: the Hyperdrive ids
   in the config, the bucket, both Workers, and the secrets' names (`npx wrangler secret list`,
   in the root and in platform/).
6. Email (step 6): walk me through verifying the sending domains and adding the bounce webhook.
   I'll put the webhook's secret in the provider myself.
7. Check the deploy over HTTPS with curl: the instance's pages load with no Cloudflare error,
   /favicon.ico is served, and on a many-camp instance a camp that doesn't exist gets a 404.
8. The first camp (step 9): give me the `npm run camp:create` command to run in my terminal,
   since it needs the email API key. Then ask me whether the Admin's email arrived and the
   sign-in worked.
9. If I want GitHub deploys, step 11: set the repository variables with gh once I've agreed,
   tell me how to create the environments, and give me the `gh secret set` commands to run myself.
10. Backups and the isolation probe (step 10), if I want backups. The age private key stays
    offline with me, never on this machine or in the repository. Remind me to run a restore
    drill once the first backup exists.
11. Commit my instance's files on a branch, show me the diff, and ask before pushing.

## At the end

Tell me, briefly: what's running and at which addresses; what you created (Worker, Hyperdrive and
bucket names and ids, which aren't secret); every check you ran and its result; what's left for me
(legal review, Access, backups, a restore drill…); and anything that didn't go as the guide said.
No secrets in the summary.
```

## If it goes wrong

The agent stops at any failure, by the rules above. The steps in `self-hosting.md` say what each command does, so you can pick up by hand from wherever it stopped. `npm run setup` is safe to re-run: it reuses what already exists.

If the guide was wrong or unclear, please [open an issue](https://github.com/themecampapp/themecampapp/issues/new/choose) with the "Self-hosting help" template, and say what the agent saw. That's how the guide gets better.
