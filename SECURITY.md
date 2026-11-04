# Security

Theme Camp App holds camps' member lists, contact details and dues, so we take reports seriously and answer them quickly.

## Reporting a vulnerability

**Don't open a public issue.** Report it privately, in either of these ways:

- **GitHub:** the repository's **Security** tab → **Report a vulnerability**. This opens a private advisory that only the maintainers can see.
- **Email:** hello@themecamp.app, with "Security" in the subject.

Say what you found, how to reproduce it, and what someone could do with it. A proof of concept against your own instance, or against the [demo camp](https://demo.themecamp.app), is the most helpful. Please don't test against real camps on the hosted service, or access data that isn't yours.

**We'll reply within 3 working days**, and keep you posted until it's fixed. If you'd like credit, we'll name you in the advisory.

## What happens next

1. We confirm the problem in a private security advisory, and develop the fix in the advisory's private fork.
2. **The hosted service ([themecamp.app](https://themecamp.app)) is fixed first.** The maintainer deploys the fix to it by hand from the private fork, before anything is public. This is the one time production runs code ahead of a public release.
3. The fix is merged, released, and the advisory published, usually within days. Self-hosted instances hear about it through the GitHub advisory, so watch the repository's security advisories.

## Supported versions

Fixes go into the latest release, so upgrade to it (`docs/upgrading.md`).

## Scope

In scope: anything that lets someone see or change another camp's data, act as someone they aren't, get around a role's limits, read private details they shouldn't, or keep a deleted person's or camp's data past its deletion. Also anything that breaks the read-only rules of the demo camp, suspended camps or support access.

Out of scope: problems that need someone's email account or device already in an attacker's hands, denial of service by volume, missing hardening headers with no attack behind them, and the configuration of someone else's self-hosted instance (tell its operator).

How the app protects camps is in [`docs/security.md`](docs/security.md).
