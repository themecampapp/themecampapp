// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { data, Form, Link, redirect } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { getTemplate, resetTemplate, saveTemplate } from "~/lib/data/email-templates.server";
import { currentYear } from "~/lib/data/participation.server";
import { BODY_MAX, fill, type MailKind, SUBJECT_MAX } from "~/lib/email-templates";
import type { Route } from "./+types/_app.admin.emails.$kind";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${loaderData?.template.name ?? "Email"} · Admin`) }];
}

// A switched-off feature's emails aren't sent, so they aren't listed or editable either.
async function editableTemplate(context: Route.LoaderArgs["context"], kind: string) {
  const template = await getTemplate(getDb(context), kind);
  const { features } = await getSettings(context);
  if (template.feature && !features[template.feature]) {
    throw data({ reason: "not_found" }, { status: 404 });
  }
  return template;
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const db = getDb(context);
  const { env } = context.get(cloudflareContext);
  return {
    template: await editableTemplate(context, params.kind),
    year: await currentYear(db),
    sampleLink: new URL("/sign-in?email=camper%40example.com", env.APP_URL).toString(),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const db = getDb(context);
  const viewer = getViewer(context);
  const { name, kind } = await editableTemplate(context, params.kind);
  const form = await request.formData();
  if (form.get("intent") === "reset") {
    await resetTemplate(db, viewer, kind as MailKind);
    return redirect(`/admin/emails?notice=${encodeURIComponent(`${name}: reset to the default.`)}`);
  }
  const problem = await saveTemplate(db, viewer, kind as MailKind, {
    subject: String(form.get("subject") ?? ""),
    body: String(form.get("body") ?? ""),
  });
  if (problem) return { error: problem };
  return redirect(`/admin/emails?notice=${encodeURIComponent(`${name}: saved.`)}`);
}

export default function EditEmail({ loaderData, actionData }: Route.ComponentProps) {
  const { template: t, year, sampleLink } = loaderData;
  const [subject, setSubject] = useState(t.current.subject);
  const [body, setBody] = useState(t.current.body);
  const { campName } = useCamp();
  const sample = { link: sampleLink, year, day: "Friday, August 21", camp: campName };
  return (
    <section className="max-w-3xl space-y-5">
      <Link to="/admin/emails" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Emails
      </Link>
      <PageHeader title={t.name} />
      <p className="text-sm text-charcoal">
        {`Sent when: ${t.when}`}
        {t.customized ? " This email has been edited." : " This is the default wording."}
      </p>
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}

      <div className="grid gap-5 md:grid-cols-2">
        <Form method="post" className="space-y-3">
          <Field label="Subject" hint="You can use {year} and {camp}.">
            <input
              name="subject"
              value={subject}
              maxLength={SUBJECT_MAX}
              onChange={(e) => setSubject(e.target.value)}
              className={input}
            />
          </Field>
          <Field
            label="Body"
            hint={`Plain text. {link} is ${t.link}${t.required.includes("link") ? " and must stay in" : ""}. {year} is the season being planned. {camp} is the camp's name. No web or email addresses: {link} is the only link.${t.extra?.includes("day") ? " {day} is the pass's arrival day." : ""}`}
          >
            <textarea
              name="body"
              value={body}
              rows={14}
              maxLength={BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
              className={`${input} font-mono text-sm`}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn.primary}>
              Save
            </button>
            {t.customized && (
              <button
                type="submit"
                name="intent"
                value="reset"
                formNoValidate
                className={btn.secondary}
                onClick={(e) => {
                  if (!confirm("Go back to the default wording?")) e.preventDefault();
                }}
              >
                Reset to default
              </button>
            )}
          </div>
        </Form>

        <div className="space-y-2">
          <div className="text-sm font-medium">Preview</div>
          <div className="rounded-xl bg-white p-4 text-sm ring-1 ring-dust-light">
            <div className="mb-3 border-b border-dust-light pb-2 font-semibold">
              {fill(subject, sample)}
            </div>
            <div className="whitespace-pre-wrap break-words">{fill(body, sample)}</div>
          </div>
          <p className="text-xs text-charcoal">The link and year shown are examples.</p>
        </div>
      </div>
    </section>
  );
}
