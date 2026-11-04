# How Theme Camp App protects camps

This is the threat model: what the app protects, from whom, how, and what it leaves to others. It's for reviewers, contributors and anyone deciding whether to run an instance. Everything here is in the code; this page is the map. To report a problem, see [`SECURITY.md`](../SECURITY.md).

## What's worth protecting

- **Camp isolation.** Many camps share one database and one set of Workers. One camp must never see or change another's people, dues, notes or files, even through a bug in a page.
- **Personal details.** Members' names, emails, phones, home locations, mailing addresses, photos, dues status, and notes Leads write about them. Inside a camp, each role sees only what the camp lets it see.
- **Sign-in.** Nobody may act as someone else, in their camp or another.
- **Deletion.** When a person or camp is deleted, their data goes, on the schedule the Privacy Policy states.

## Who we defend against

- **A member of one camp** trying to reach another camp's data, or more of their own camp's than their role allows.
- **Someone on the internet** with no account: probing which camps exist, guessing sign-in links, flooding forms, or embedding the app to trick people.
- **A bug in our own code.** A page that forgets a check should still not be able to leak across camps.
- **The operator**, to a degree: the hosted service's operator sees a camp's data only while one of its Admins grants support access, read-only, and every page they view is in the camp's Activity.

## The controls

**Camp isolation, in the database itself**

- Every camp table has `camp_id`, with a **forced row-level security policy**: a row is visible only when it belongs to the camp set for the current transaction. The Workers connect as roles that can't bypass it (`app_runtime`, `app_platform`), never as the owner.
- The camp is set **per transaction**, never per connection, since connections are pooled across camps (`app/lib/tenancy.server.ts`). A page has no way to reach the database except through that camp's client.
- The few queries that must cross camps (finding which camps an email belongs to, operator counts) are `SECURITY DEFINER` functions owned by a role that can't log in, with a pinned `search_path`, listed in `scripts/db-grants.ts`.
- **Every deploy checks** that no Worker role can bypass row-level security, own anything or change the audit log, and that every camp table has its policy. The deploy fails otherwise.
- **The isolation probe** checks the live database for real, as a read-only role: hourly in the platform Worker's health check and daily from GitHub Actions. A failure is treated as an incident.
- **Every route is tested** with camp A's Admin aiming at camp B's records (`tests/authz/cross-camp.registry.ts`). A new route fails CI until it has a probe.

**Sign-in and sessions**

- Magic links only: no passwords to steal or reuse. Links are single-use, expire, and carry the issuing camp, so a link from one camp doesn't work at another.
- Sessions are per camp: a session records its camp and is refused anywhere else, and cookies are host-only.
- Membership is by invitation, linked to one exact email in one camp. Anything ambiguous waits for a Lead.
- Sign-in attempts are rate limited, and each camp's Admins can see its sign-in log.

**Inside a camp**

- What someone can do is a level per area (`app/lib/permissions.ts`), checked on every request by the signed-in layout. Changes need Manage. Only Admins give roles, and acting on a person needs at least everything that person can do.
- Private details (unshared contact details, mailing addresses, notes) follow one rule (`app/lib/contact-sharing.server.ts`).
- Changes are written to the camp's audit log, which the app can add to but never edit.

**Read-only modes**

- **The demo camp** saves nothing: the Worker refuses its posts, its database transactions are read-only, its file storage refuses writes, and it sends no email.
- **Support access** is read-only: the Worker refuses every change made with the support cookie, whatever the route allows.
- **A suspended camp** is read-only, except signing in and out.

**The edges**

- **Same-origin writes:** every camp subdomain is the same site to the browser, so every write must come from the camp's own exact origin. A missing `Origin` header is refused.
- **Headers:** a strict Content-Security-Policy (no framing, no third-party scripts beyond Turnstile), HSTS, `nosniff`, no referrer, and `no-store` on everything that isn't public.
- **Unknown camps** get the same page as any unknown host, so nobody can list the camps.
- **Forms open to the public** (joining a camp, the sign-up page) have Turnstile and per-address rate limits. Request bodies are capped before they're read.
- **Files** are in a private bucket under each camp's prefix, and served only to that camp's members, when one of the camp's rows points at them.
- **Email** never carries tracking, so sign-in links never pass through a third party. Bounced and complained addresses are suppressed, and a camp whose mail bounces is paused.

**Deletion and backups**

- A deleted camp closes at once and is deleted for good after 30 days, files included. A deleted login is removed from every camp, and history shows "a deleted member".
- Backups are encrypted with a key kept offline, and age out within 90 days.

## Out of scope

- **A member's email account.** Whoever controls someone's inbox can sign in as them. That's the trade for having no passwords.
- **What a camp's own Admins do.** An Admin can see and change everything in their camp. Camps choose their Admins.
- **Denial of service by volume.** Cloudflare absorbs a lot, but the app doesn't defend against it beyond rate limits on public forms.
- **Infrastructure we don't run:** Cloudflare, the database host and the email provider are trusted with what they handle.
- **A self-hosted instance's own setup.** Its operator holds its secrets and database, and is responsible for them.
