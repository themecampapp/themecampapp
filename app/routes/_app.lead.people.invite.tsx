// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useNavigation } from "react-router";
import { btn, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { currentYear } from "~/lib/data/participation.server";
import { bulkInviteCandidates, sendBulkInvites } from "~/lib/invites.server";
import { heldNotice } from "~/lib/mail.server";
import type { Route } from "./+types/_app.lead.people.invite";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Invite returning campers") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  return {
    lastYear: (await currentYear(db)) - 1,
    candidates: await bulkInviteCandidates(db, getViewer(context)),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const ids = form.getAll("personId").map(String);
  if (!ids.length) return { error: "Pick at least one person." };
  const { sent, failed, held } = await sendBulkInvites(
    getDb(context),
    context.get(cloudflareContext).env,
    getViewer(context),
    ids,
  );
  const heldCount = Object.values(held).reduce((n, v) => n + (v ?? 0), 0);
  const failedCount = failed.length - heldCount;
  const msg = [
    `Invited ${sent} ${sent === 1 ? "person" : "people"}.`,
    failedCount > 0 &&
      `${failedCount} emails failed to send; they're marked invited, so use "Resend invite" on each.`,
    heldNotice(held),
  ]
    .filter(Boolean)
    .join(" ");
  return redirect(`/people?status=invited&notice=${encodeURIComponent(msg)}`);
}

export default function BulkInvite({ loaderData, actionData }: Route.ComponentProps) {
  const { candidates } = loaderData;
  const busy = useNavigation().state === "submitting";
  return (
    <section className="max-w-2xl">
      <PageHeader title="Invite returning campers" />
      <p className="mb-4 text-charcoal">
        {`Everyone below came in ${loaderData.lastYear},`} has a unique email, and hasn't been
        invited yet. Each gets an email with a link to the sign-in page. People with a missing or
        shared email aren't listed; fix them from their person page or the Lead queue. Admins and
        Treasurers are only listed if you can manage their sign-in access.
      </p>
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      {candidates.length === 0 ? (
        <Notice>No one is waiting for an invite.</Notice>
      ) : (
        <Form method="post" className="space-y-4">
          <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex items-center gap-3 px-4 py-2.5">
                  <input type="checkbox" name="personId" value={c.id} defaultChecked />
                  <span>
                    <span className="font-medium">{c.playa_name ?? c.legal_name}</span>
                    <span className="ml-2 text-sm text-charcoal">{c.email}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="submit" className={btn.primary} disabled={busy}>
              {busy ? "Sending…" : `Send ${candidates.length} invites`}
            </button>
            <Link to="/people" className={btn.secondary}>
              Cancel
            </Link>
          </div>
        </Form>
      )}
    </section>
  );
}
