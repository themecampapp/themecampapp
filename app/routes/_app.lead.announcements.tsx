// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useLocation, useNavigation, useSearchParams } from "react-router";
import { LinkedText } from "~/components/LinkedText";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { BODY_MAX, MAX_DAYS, TITLE_MAX } from "~/lib/announcements";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import {
  announcementEmail,
  announcementRecipients,
  currentAnnouncements,
  editAnnouncement,
  emailAnnouncement,
  emailable,
  latestShowUntil,
  postAnnouncement,
  removeAnnouncement,
} from "~/lib/data/announcements.server";
import { formError } from "~/lib/errors";
import { campName, heldNotice } from "~/lib/mail.server";
import type { Route } from "./+types/_app.lead.announcements";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Announcements") }];
}

// Post, edit and remove the camp's home-page announcements (R61). Any Lead may change any of
// them; every change is audited. Each can be emailed to the season's members once (R62),
// after a preview of exactly what goes out.
export async function loader({ request, context }: Route.LoaderArgs) {
  const db = getDb(context);
  const emailId = new URL(request.url).searchParams.get("email");
  const toEmail = emailId ? await emailable(db, emailId) : null;
  if (emailId && !toEmail) {
    throw redirect(
      `/announcements?notice=${encodeURIComponent("That announcement has already been emailed, or has ended.")}`,
    );
  }
  let preview = null;
  if (toEmail) {
    const { env } = context.get(cloudflareContext);
    preview = {
      id: toEmail.id,
      title: toEmail.title,
      ...announcementEmail(toEmail, await campName(db), env.APP_URL),
      recipients: (await announcementRecipients(db)).length,
    };
  }
  return {
    announcements: (await currentAnnouncements(db)).map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      emailedAt: a.emailedAt?.toISOString() ?? null,
    })),
    latest: await latestShowUntil(db),
    preview,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) => redirect(`/announcements?notice=${encodeURIComponent(msg)}`);
  const values = { title: get("title"), body: get("body"), showUntil: get("showUntil") };
  try {
    switch (get("intent")) {
      case "post": {
        const row = await postAnnouncement(db, viewer, values);
        // Emailing is a second, deliberate step: the preview shows exactly what goes out.
        if (form.get("email") === "on") return redirect(`/announcements?email=${row.id}`);
        return done("Posted. Members see it on their home page.");
      }
      case "send_email": {
        const { env } = context.get(cloudflareContext);
        const r = await emailAnnouncement(db, env, viewer, get("id"));
        const parts = [`Emailed to ${r.sent} ${r.sent === 1 ? "person" : "people"}.`];
        const failed = r.failed.length - Object.values(r.held).reduce((n, c) => n + (c ?? 0), 0);
        if (failed > 0) parts.push(`${failed} failed to send; see the Queue.`);
        const held = heldNotice(r.held);
        if (held) parts.push(held);
        return done(parts.join(" "));
      }
      case "edit":
        await editAnnouncement(db, viewer, get("id"), values);
        return done("Announcement updated.");
      case "remove":
        await removeAnnouncement(db, viewer, get("id"));
        return done("Announcement removed.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

const day = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Fields({
  title = "",
  body = "",
  showUntil = "",
  latest,
}: {
  title?: string;
  body?: string;
  showUntil?: string;
  latest: string;
}) {
  return (
    <>
      <Field label="Title">
        <input name="title" defaultValue={title} required maxLength={TITLE_MAX} className={input} />
      </Field>
      <Field label="Message" hint="Plain text. https:// links show with their full address.">
        <textarea name="body" defaultValue={body} rows={4} maxLength={BODY_MAX} className={input} />
      </Field>
      <Field
        label="Show until"
        hint={`It comes off the home page after this day (${MAX_DAYS} days at most).`}
      >
        <input
          type="date"
          name="showUntil"
          defaultValue={showUntil}
          max={latest}
          required
          className={`${input} w-44`}
        />
      </Field>
    </>
  );
}

function EmailPreview({
  preview,
}: {
  preview: NonNullable<Route.ComponentProps["loaderData"]["preview"]>;
}) {
  return (
    <div className="space-y-3 rounded-xl bg-white p-4 ring-2 ring-gold">
      <h2 className="font-semibold">{`Email “${preview.title}” to members?`}</h2>
      <p className="text-sm">
        {`It goes to ${preview.recipients} ${preview.recipients === 1 ? "person" : "people"}: everyone active on this year's list with an email, except anyone who said they're not going. It can be sent once; editing the announcement later doesn't send it again.`}
      </p>
      {preview.removed > 0 && (
        <Notice tone="info">
          {`${preview.removed} ${preview.removed === 1 ? "link was" : "links were"} taken out of the email. The email only links to the camp site, where the announcement shows in full.`}
        </Notice>
      )}
      <div className="rounded-lg bg-dust-pale p-3 text-sm">
        <p className="font-semibold">{preview.subject}</p>
        <p className="mt-2 whitespace-pre-line">{preview.text}</p>
      </div>
      <Form method="post" className="flex flex-wrap gap-2">
        <input type="hidden" name="id" value={preview.id} />
        <button type="submit" name="intent" value="send_email" className={btn.primary}>
          {`Send to ${preview.recipients}`}
        </button>
        <Link to="/announcements" className={btn.secondary}>
          Not now
        </Link>
      </Form>
    </div>
  );
}

export default function Announcements({ loaderData, actionData }: Route.ComponentProps) {
  const { announcements, latest, preview } = loaderData;
  const [params] = useSearchParams();
  // A new page location means the post went through: start the form afresh, so it can't be
  // posted again by pressing Post a second time. (After an error it keeps what was typed.)
  const { key } = useLocation();
  const navigation = useNavigation();
  const posting = navigation.state !== "idle" && navigation.formData?.get("intent") === "post";
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Announcements" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      {preview && <EmailPreview preview={preview} />}

      <Form
        key={key}
        method="post"
        className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light"
      >
        <h2 className="font-semibold">New announcement</h2>
        <input type="hidden" name="intent" value="post" />
        <Fields latest={latest} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="email" />
          Also email it to members (you'll see the email before it's sent)
        </label>
        <button type="submit" disabled={posting} className={btn.primary}>
          {posting ? "Posting…" : "Post"}
        </button>
      </Form>

      <h2 className="font-semibold">On the home page now</h2>
      {announcements.length === 0 ? (
        <p className="text-sm text-charcoal">No current announcements.</p>
      ) : (
        <ul className="space-y-3">
          {announcements.map((a) => (
            <li key={a.id} className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <p className="font-semibold">{a.title}</p>
              {a.body && (
                <p className="text-sm">
                  <LinkedText text={a.body} />
                </p>
              )}
              <p className="text-xs text-charcoal">
                {`Showing until ${day(a.showUntil)}. `}
                {a.emailedAt ? (
                  `Emailed ${day(a.emailedAt.slice(0, 10))} to ${a.emailedCount ?? 0}.`
                ) : (
                  <Link to={`/announcements?email=${a.id}`} className="underline">
                    Email it to members…
                  </Link>
                )}
              </p>
              <details>
                <summary className="cursor-pointer text-sm underline">Edit or remove</summary>
                <Form method="post" className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={a.id} />
                  <Fields title={a.title} body={a.body} showUntil={a.showUntil} latest={latest} />
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" name="intent" value="edit" className={btn.primary}>
                      Save
                    </button>
                    <button
                      type="submit"
                      name="intent"
                      value="remove"
                      formNoValidate
                      className={btn.secondary}
                    >
                      Remove now
                    </button>
                  </div>
                </Form>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
