# 0002: Who owns the code (open-source plan, Unit 0.2)

*Recorded 2026-10-11. The operator confirmed on 2026-10-11 that Curtis Kline is the author of all of it: the code of both apps and Yellow Balloon's guides and role descriptions. Revised 2026-10-16: he keeps the copyright personally, so there's no assignment (decision D3).*

## Where the code came from

- **This repository** started as a copy of the Yellow Balloon camp app (`yellowballooncampapp`, commit `9d21ea18`, 2026-09-28; see `docs/fork.md`). Every commit since is by Curtis Kline.
- **The Yellow Balloon app's own repositories** (`curtiskline/yellowballooncampapp`, `curtiskline/yellowballoon`) have commits only from the `curtiskline` and `curtis-fml` GitHub accounts.
  - **Confirmed:** both accounts are Curtis Kline's, and nobody else wrote code for the Yellow Balloon app.
- **Much of the code was written with AI coding assistants,** under the operator's direction (commits carry a `Co-Authored-By` line). The operator reviewed and accepted it.
  - **For the lawyer:** whether that affects copyright in those parts, and anything the license or README should say about it.

## Written and owned by the operator

**Confirmed:** Curtis Kline wrote the Yellow Balloon app and Theme Camp App, and holds the copyright personally (decision D3, revised 2026-10-16). He publishes it under the AGPL-3.0-or-later. Kline Technology LLC runs the hosted service under that same license; nothing is assigned to it.

## Third-party code

Checked 2026-10-11:

- **No code copied in from elsewhere.** No license headers, vendored libraries or "adapted from" notes anywhere in `app/`, `platform/`, `workers/`, `scripts/` or `tests/`.
- **Dependencies come from npm** under their own licenses: mostly MIT, ISC, Apache-2.0 and BSD, a few MPL-2.0, one LGPL-3.0. All are compatible with the AGPL (checked 2026-10-04, open-source plan "Where things stand").
- **The font, DM Sans,** loads from Google Fonts under the SIL Open Font License. It isn't copied into the repository.
- **The icons and images** in `public/` and `platform/public/` (favicon and apple-touch icon) were made for the app, from initials.

## Text that came from Yellow Balloon's own documents

Not code, but published with it:

- **`content/starter-guides/*`:** the general starter guides offered to every camp, adapted from Yellow Balloon's guides (`scripts/yb-guides/`).
- **`tests/helpers/seed.ts`:** the test camp's job titles and descriptions, copied from Yellow Balloon's real volunteer roles.
- **`scripts/yb-guides/`, `scripts/import-2026/`, `scripts/import-history/`:** Yellow Balloon's guides and import tools. These are removed before publishing (open-source plan, Unit 1.1).

**Confirmed:** Curtis Kline wrote Yellow Balloon's guides and its volunteer role descriptions, so the starter guides and test seed can be published as they are.
