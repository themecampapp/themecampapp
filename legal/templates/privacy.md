*A template for self-hosted instances. It's an example, not legal advice: adapt it with your own lawyer, and replace everything in [square brackets]. {product}, {operator} and {contact} are filled in from your instance's config. It's written for an instance run for several camps. If you run it only for your own camp, your camp is the "we" below and decides everything itself: say so under "Who decides what" ("Privacy: your role" in docs/self-hosting.md).*

{product} is run by {operator} ("we", "us"). This is what we store about people, why, and who can see it.

## Who decides what

- **Each camp** decides what it keeps about its people and who it invites. If you have a question about what a camp has on you, ask its organizers first.
- **We** store and process that information for the camp, to run {product}, and for nothing else.
- **We don't look** at a camp's information unless one of its Admins grants us support access. Every page we open then is listed in the camp's Activity for its Admins to see.

## What's stored

- **Your sign-in:** your email address, and a log of sign-in attempts (when a link was asked for and whether it worked), so a camp's Admins can help when signing in goes wrong.
- **What your camp keeps about you:** your name and playa name, email, phone, home location, mailing address (only if your camp collects it; only the people your camp lets see private details do) and photo, and whatever you share about coming to the burn: your RSVP, arrival and departure, your dwelling and generator, your Stewards Sale ticket request, whether your dues are paid (never card or bank details: dues are paid outside the app), the jobs you take on, and notes camp Leads write.
- **The join page:** what someone sends when asking to join a camp.
- **Email:** a record of each email the app sent for a camp, and whether it bounced.
- **Usage counts:** how many times each part of the app was used, per camp per day (for example, page views by page type, sign-ins, RSVPs saved, errors), and how many members used the app in the last 7 and 30 days. They're numbers only, never who did what, and help us see what works and what breaks. To count active members, the app notes the last day each person used it. {feature:usage}
- **A camp's sign-up request:** the camp's name and address, the organizers' names and emails, the season, its rough size and any note, so we can set the camp up and email its organizers. {feature:signupPage}
- **Feedback you send us:** your words, the camp, the page you sent it from (without anything that identifies a record) and your role in the camp. We read it to improve {product}. It doesn't record who you are, and your camp's Leads don't see it. {feature:feedback}

## What we don't do

We don't sell or share anyone's information, show ads, or use analytics or tracking. The only cookies keep you signed in (and mark a visit to the demo camp).

## Who else handles it

- **Cloudflare** runs the app and stores its files.
- **[Your database host]** hosts the database, in [region].
- **[Your email provider]** sends the app's email.
- **[Where you keep backups]** keeps our encrypted backups.
- **Discord** gets a short notice when someone signs in or a camp is created: the camp, a role and the time, never names or emails. {feature:discord}

Each handles information only to provide that service to us.

## Who in a camp sees what

Other members see your Yearbook name and photo, and your contact details only if you choose to share them. People your camp gives a role see what that role needs, and each camp decides which roles see private details and dues; your camp's "Who can see what" page, linked from your profile, lists them. Admins manage the camp's settings.

## How long it's kept

- A camp's information is kept while the camp uses {product}.
- **A deleted camp** closes at once, can be restored for 30 days, and is then deleted for good. Backups age out within 90 days.
- **Your login:** you can ask us to delete it. Your name and contact details are then removed from every camp you're in. A camp's history keeps its records, with you shown as "a deleted member".
- **Sign-up requests** are deleted 90 days after we approve or decline them. An approved camp's organizers become its first Admins. {feature:signupPage}
- **Feedback** is kept for 12 months. {feature:feedback}
- **Usage counts** are kept for about 13 months. {feature:usage}
- **Sign-in logs** are kept, during the pilot, until the camp or login is deleted. We'll keep them for 90 days at most before {product} opens more widely.

## Your choices

You can change your details on your profile, choose whether other members see your contact details, and ask a camp's organizers to remove you. To have your login deleted, or for anything else, contact us: {contact}.
