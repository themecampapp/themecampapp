*A template for self-hosted instances. It's an example, not legal advice: adapt it with your own lawyer, and replace everything in [square brackets]. {product}, {operator} and {contact} are filled in from your instance's config.*

A short, plain description of how {product} keeps camps' information safe. The Privacy Policy covers what's stored and why.

## Every camp is kept apart

Every record belongs to one camp, and the database itself refuses to show one camp's records to another (row-level security). This is tested on every change, and checked on the live database every hour and every day.

## Who can get in

- **Camp members** sign in with a one-time link to their email. What they see depends on their role in the camp.
- **We (the operator)** see a camp's information only when one of its Admins grants support access. It's read-only, it expires, and every page we open is listed in the camp's Activity.
- **Emergency database access**, for example to fix something broken, is recorded in our operator log with the reason.

## Where it lives

The app runs on Cloudflare. The database is [your database host], in [region]. Files (photos and passes) are in Cloudflare's storage. Everything travels over HTTPS and is encrypted where it's stored.

## Backups

The database is backed up daily, encrypted with a key only we hold, and kept for 90 days. Restoring from a backup is rehearsed before a camp's data depends on it.

## Email

Email goes out through [your email provider], with click and open tracking turned off. Addresses that bounce or complain stop getting email from any camp.

## Export and deletion

A camp's Admins can ask for a full export of the camp's data, delivered inside the app, or for the camp to be deleted (restorable for 30 days, then gone). Anyone can ask for their own login to be deleted.

## If something goes wrong

If we find that a camp's information was exposed, we'll fix it first, then tell the camp's Admins what happened and what was affected.

Questions: {contact}.
