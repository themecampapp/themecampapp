// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect } from "react-router";
import { btn, Notice, PageHeader } from "~/components/ui";
import { can, getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { getTemplate } from "~/lib/data/email-templates.server";
import { NUDGE_COOLDOWN_DAYS, nudgePreview, sendRsvpNudges } from "~/lib/data/nudge.server";
import { currentYear } from "~/lib/data/participation.server";
import { rosterView } from "~/lib/data/season-roster.server";
import { fill } from "~/lib/email-templates";
import { heldNotice } from "~/lib/mail.server";
import type { Route } from "./+types/_app.lead.roster.nudge";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "RSVP nudge") }];
}

// RSVP nudges to the people a Lead ticked on the Roster (Lead workspace plan, Unit 8). First a
// preview: who gets the email, who's skipped because they were nudged recently, who can't be
// nudged and why, and the email itself. Then Send, which works it all out again. Only people
// in the Roster view the Lead was looking at count: ids from anywhere else are dropped.
// (No redirect here: after the preview's POST the loader runs again before the page renders.)
export function loader() {
  return null;
}

// "?preset=…" from the form, kept to a roster query string.
const searchOf = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "");
  return /^\?[^#]{0,500}$/.test(s) ? s : "";
};

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const search = searchOf(form.get("search"));
  const { features, name: camp } = await getSettings(context);
  const treasurer = can(viewer, "dues") && features.dues;
  const { rows } = await rosterView(
    db,
    { dues: treasurer, contact: can(viewer, "private") },
    search,
  );
  const wanted = new Set(form.getAll("id").map(String));
  const selected = rows.filter((r) => wanted.has(r.id));
  const back = `/roster${search}`;

  if (form.get("intent") === "send") {
    const ids = selected.map((r) => r.id);
    const { env } = context.get(cloudflareContext);
    const r = await sendRsvpNudges(db, env, viewer, ids);
    const failedNames = selected
      .filter((p) => p.email && r.failedTo.includes(p.email))
      .map((p) => p.name);
    const parts = [`Sent ${r.sent} RSVP ${r.sent === 1 ? "nudge" : "nudges"}.`];
    if (r.skipped) parts.push(`${r.skipped} skipped.`);
    if (failedNames.length) parts.push(`Not sent to ${failedNames.join(", ")}.`);
    const held = heldNotice(r.held);
    if (held) parts.push(held);
    const sep = search ? "&" : "?";
    return redirect(`${back}${sep}notice=${encodeURIComponent(parts.join(" "))}`);
  }

  const template = (await getTemplate(db, "rsvp_nudge")).current;
  const vars = { link: "(their own sign-in link)", year: await currentYear(db), camp };
  return {
    search,
    back,
    ...(await nudgePreview(db, selected)),
    email: { subject: fill(template.subject, vars), body: fill(template.body, vars) },
    cooldownDays: NUDGE_COOLDOWN_DAYS,
  };
}

export default function NudgePreview({ actionData }: Route.ComponentProps) {
  if (!actionData) {
    return (
      <section className="max-w-2xl space-y-3">
        <PageHeader title="Send RSVP nudges" />
        <p className="text-sm">
          Tick the people to nudge on the{" "}
          <Link to="/roster?preset=no-rsvp" className="underline">
            Roster
          </Link>
          , then press "Nudge picked to RSVP".
        </p>
      </section>
    );
  }
  const { send, cooldown, notEligible, email, search, back, cooldownDays } = actionData;
  return (
    <section className="max-w-2xl space-y-5">
      <Link to={back} className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Back to the roster
      </Link>
      <PageHeader title="Send RSVP nudges?" />
      {send.length === 0 ? (
        <Notice>No one you picked can be nudged right now.</Notice>
      ) : (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Will be emailed (${send.length})`}</h2>
          <p className="text-sm">{send.map((p) => p.name).join(", ")}</p>
        </div>
      )}
      {cooldown.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Skipped: nudged in the last ${cooldownDays} days (${cooldown.length})`}</h2>
          <ul className="list-disc pl-5 text-sm">
            {cooldown.map((p) => (
              <li key={p.id}>{`${p.name}, on ${new Date(p.lastNudgedAt).toLocaleDateString()}`}</li>
            ))}
          </ul>
        </div>
      )}
      {notEligible.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Can't be nudged (${notEligible.length})`}</h2>
          <ul className="list-disc pl-5 text-sm">
            {notEligible.map((p) => (
              <li key={p.id}>{`${p.name}: ${p.reason}`}</li>
            ))}
          </ul>
        </div>
      )}
      {send.length > 0 && (
        <>
          <div className="space-y-1 rounded-xl bg-white p-4 text-sm ring-1 ring-dust-light">
            <p className="font-semibold">{email.subject}</p>
            <p className="whitespace-pre-line text-charcoal">{email.body}</p>
          </div>
          <Form method="post" className="flex gap-2">
            <input type="hidden" name="intent" value="send" />
            <input type="hidden" name="search" value={search} />
            {send.map((p) => (
              <input key={p.id} type="hidden" name="id" value={p.id} />
            ))}
            <button type="submit" className={btn.primary}>
              {`Send ${send.length} ${send.length === 1 ? "email" : "emails"}`}
            </button>
            <Link to={back} className={btn.secondary}>
              Cancel
            </Link>
          </Form>
        </>
      )}
    </section>
  );
}
