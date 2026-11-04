// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { PersonLink } from "~/components/PersonLink";
import { btn, Field, INQUIRY_LABEL, input, Notice, PageHeader } from "~/components/ui";
import { inquiry } from "~/db/schema";
import { getViewer } from "~/lib/access.server";
import { listActivity } from "~/lib/activity.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import {
  addInquiryNote,
  closeAsExistingCamper,
  getInquiry,
  type InquiryStatus,
  inviteFromInquiry,
  updateInquiry,
} from "~/lib/data/inquiries.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.lead.inquiries.$id";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${loaderData?.inquiry.name ?? "Inquiry"}`) }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const db = getDb(context);
  const found = await getInquiry(db, params.id);
  if (!found) throw data({ reason: "not_found" }, { status: 404 });
  const { inquiry: i, notes, matches, leads } = found;
  return {
    inquiry: {
      id: i.id,
      name: i.name,
      playaName: i.playaName,
      email: i.email,
      phone: i.phone,
      heardFrom: i.heardFrom,
      note: i.note,
      status: i.status,
      source: i.source,
      personId: i.personId,
      assignedToPersonId: i.assignedToPersonId,
      receivedAt: i.receivedAt.toISOString(),
    },
    notes: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    matches,
    leads,
    history: (await listActivity(db, { inquiryId: i.id, limit: 50 })).rows,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const id = params.id;
  const back = (msg: string) => redirect(`/inquiries/${id}?notice=${encodeURIComponent(msg)}`);
  // Only this camp's inquiries exist here (row-level security): anyone else's is a 404.
  const [exists] = await db.select({ id: inquiry.id }).from(inquiry).where(eq(inquiry.id, id));
  if (!exists) throw data({ reason: "not_found" }, { status: 404 });
  try {
    switch (form.get("intent")) {
      case "note":
        await addInquiryNote(db, viewer, id, String(form.get("body") ?? ""));
        return back("Note added.");
      case "status": {
        const status = String(form.get("status")) as InquiryStatus;
        if (!["new", "contacted", "met", "declined"].includes(status))
          return { error: "Unknown status." };
        await updateInquiry(db, viewer, id, { status });
        return back(`Marked ${INQUIRY_LABEL[status].toLowerCase()}.`);
      }
      case "assign": {
        const to = String(form.get("assignedTo") ?? "");
        await updateInquiry(db, viewer, id, { assignedToPersonId: to || null });
        return back(to ? "Assigned." : "Unassigned.");
      }
      case "close_existing": {
        await closeAsExistingCamper(db, viewer, id, String(form.get("personId") ?? ""));
        return back("Closed as an existing camper. No email was sent.");
      }
      case "invite": {
        const personId = String(form.get("personId") ?? "");
        const result = await inviteFromInquiry(
          db,
          context.get(cloudflareContext).env,
          viewer,
          id,
          personId ? { personId } : { create: true },
        );
        const msg = result.alreadyMember
          ? "They're already a member, so no invite was sent. Marked invited."
          : "Invite sent. They can now sign in and RSVP.";
        return redirect(`/people/${result.personId}?notice=${encodeURIComponent(msg)}`);
      }
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

export default function InquiryPage({ loaderData, actionData }: Route.ComponentProps) {
  const { inquiry: i, notes, matches, leads, history } = loaderData;
  const [params] = useSearchParams();
  const closed = i.status === "invited" || i.status === "declined";
  return (
    <section className="max-w-2xl space-y-5">
      <div>
        <Link to="/inquiries" className="inline-block text-sm underline pointer-coarse:py-2.5">
          ← Inquiries
        </Link>
        <PageHeader title={i.name}>
          <span className="rounded-full bg-dust-pale px-3 py-1 text-sm ring-1 ring-dust">
            {INQUIRY_LABEL[i.status]}
          </span>
        </PageHeader>
        {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
        {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      </div>

      <dl className="grid gap-3 rounded-xl bg-white p-4 text-sm ring-1 ring-dust-light sm:grid-cols-2">
        {[
          ["Playa name", i.playaName],
          ["Email", i.email],
          ["Phone", i.phone],
          ["Heard about us", i.heardFrom],
          [
            "Received",
            `${new Date(i.receivedAt).toLocaleDateString()}${i.source === "import" ? " (imported)" : ""}`,
          ],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="font-medium">{k}</dt>
            <dd className="text-charcoal">{v || "—"}</dd>
          </div>
        ))}
        {i.note && (
          <div className="sm:col-span-2">
            <dt className="font-medium">Their note</dt>
            <dd className="whitespace-pre-wrap text-charcoal">{i.note}</dd>
          </div>
        )}
      </dl>

      {!closed && (
        <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">Invite to camp</h2>
          {!i.email ? (
            <p className="text-sm text-charcoal">
              Add an email (via a person record) before inviting.
            </p>
          ) : matches.length > 0 ? (
            <>
              <p className="text-sm text-charcoal">
                {matches.length === 1
                  ? "Someone with this email is already in the app. Is this the same person?"
                  : "Several people have this email. Pick the right one:"}
              </p>
              {matches.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-2">
                  <Form method="post">
                    <input type="hidden" name="intent" value="close_existing" />
                    <input type="hidden" name="personId" value={m.id} />
                    <button type="submit" className={btn.primary}>
                      {`Already a camper: link to ${m.name} (no email)`}
                    </button>
                  </Form>
                  {!m.signedIn && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="invite" />
                      <input type="hidden" name="personId" value={m.id} />
                      <button type="submit" className={btn.secondary}>
                        {`Invite ${m.name} now (sends email)`}
                      </button>
                    </Form>
                  )}
                  <PersonLink id={m.id} className="text-sm underline">
                    view
                  </PersonLink>
                </div>
              ))}
              <Form method="post">
                <input type="hidden" name="intent" value="invite" />
                <button type="submit" className={btn.secondary}>
                  No, create a new person and invite
                </button>
              </Form>
            </>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="invite" />
              <button type="submit" className={btn.primary}>
                Create member and send invite
              </button>
            </Form>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-4 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="status" />
          <Field label="Status">
            <select
              name="status"
              defaultValue={closed && i.status === "invited" ? "met" : i.status}
              className={input}
            >
              <option value="new">New</option>
              <option value="contacted">Contacted</option>
              <option value="met">Met</option>
              <option value="declined">Declined</option>
            </select>
          </Field>
          <button type="submit" className={btn.secondary}>
            Update
          </button>
        </Form>
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="assign" />
          <Field label="Assigned lead">
            <select name="assignedTo" defaultValue={i.assignedToPersonId ?? ""} className={input}>
              <option value="">Unassigned</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className={btn.secondary}>
            Assign
          </button>
        </Form>
      </div>

      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Contact notes (Leads only)</h2>
        {notes.length === 0 ? (
          <p className="text-sm text-charcoal">No notes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {notes.map((n) => (
              <li key={n.id}>
                <span className="text-charcoal">
                  {new Date(n.createdAt).toLocaleDateString()} · {n.author ?? "Imported"}
                </span>
                <p className="whitespace-pre-wrap">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
        <Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="note" />
          <textarea
            name="body"
            rows={3}
            required
            maxLength={2000}
            className={input}
            placeholder="e.g. Called, left voicemail"
          />
          <button type="submit" className={btn.secondary}>
            Add note
          </button>
        </Form>
      </div>

      <div className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="mb-2 font-semibold">History</h2>
        <ul className="space-y-1 text-sm">
          {history.map((h) => (
            <li key={h.id}>
              <span className="text-charcoal" suppressHydrationWarning>
                {new Date(h.at).toLocaleString()}
              </span>{" "}
              · {h.text}
              <span className="text-charcoal">
                {h.actor ? (
                  <>
                    {" · by "}
                    <PersonLink id={h.actor.id} className="underline">
                      {h.actor.name}
                    </PersonLink>
                  </>
                ) : (
                  " · by the app"
                )}
              </span>
            </li>
          ))}
          <li>
            <span className="text-charcoal" suppressHydrationWarning>
              {new Date(i.receivedAt).toLocaleString()}
            </span>{" "}
            ·{" "}
            {i.source === "import"
              ? "Imported from the spreadsheet"
              : "Received from the join form"}
          </li>
        </ul>
      </div>
    </section>
  );
}
