# Upgrading

How a self-hosted instance takes a new release, and what each release promises. The hosted service follows the same steps.

## Taking a release

Your fork tracks the canonical repository as `upstream` (`git remote add upstream https://github.com/themecampapp/themecampapp`, once).

1. **Read what's coming.** `npx tsx scripts/upgrade.ts v1.2.0` shows the notes for every release between your version and that one, the migrations they bring, and whether any have upgrade notes. It changes nothing.
2. **Do the upgrade notes that come before the deploy** (a new secret, a config field). They say which ones.
3. **Merge:** `npx tsx scripts/upgrade.ts v1.2.0 --merge`, then push `main`. CI runs, and staging deploys if you have one.
4. **Deploy production:** Actions → Deploy production. It snapshots the database, runs the migrations and `db:grants`, then deploys both Workers.
5. **Check:** sign in, open a camp's home page, and look at Admin → Guide, whose foot shows the version now running. The next hourly health check emails you if anything is off.
6. **Do the upgrade notes that come after the deploy.**

Skipping releases is fine: the migrations run in order. Read every skipped release's notes, which the script shows together.

**If a deploy goes wrong:** redeploy the previous release. If a migration ran, restore the pre-migration snapshot first ("Snapshots, backups and restores" in `docs/operating.md`), since migrations don't run backwards.

## What each release promises

Versions follow [semantic versioning](https://semver.org/): `major.minor.patch`.

- **Migrations are forward-only, and never edited after a release.** A release's migrations run once, in order, on every instance.
- **Config changes are additive within a major version.** A new setting in `config/<instance>.json` comes with a default, or the release's upgrade notes say what to set, and the config check fails the build until you do.
- **Secrets are renamed only in a major version,** after a release that reads both names and says so in its notes.
- **The minimum Postgres is 16.** CI tests 16, 17 and 18. Raising the minimum takes a major version.
- **Every release says whether it has migrations** (its changelog section always has a "Migrations" heading), and lists anything to do by hand under "Upgrade notes".
- **Security fixes** go into the latest release. Upgrade to stay covered (`SECURITY.md`).
