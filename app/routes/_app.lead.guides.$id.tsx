// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import {
  deleteGuide,
  editorGuide,
  renderGuide,
  saveGuide,
  setPublished,
} from "~/lib/data/guides.server";
import { formError, reasonOf } from "~/lib/errors";
import { BODY_MAX, SUMMARY_MAX, TITLE_MAX } from "~/lib/guides";
import type { Route } from "./+types/_app.lead.guides.$id";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${loaderData?.guide.title ?? "Guide"} · Guide editor`) }];
}

// Edit one guide: title, summary, Markdown body, who can read it; preview it exactly as it
// will render; publish or unpublish; delete a draft.
export async function loader({ params, context }: Route.LoaderArgs) {
  const g = await editorGuide(getDb(context), params.id);
  if (!g) throw data({ reason: "guide_not_found" }, { status: 404 });
  return {
    guide: {
      id: g.id,
      slug: g.slug,
      title: g.title,
      summary: g.summary,
      body: g.body,
      visibility: g.visibility,
      published: g.published,
    },
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const values = {
    title: get("title"),
    summary: get("summary"),
    body: get("body"),
    visibility: get("visibility"),
  };
  const back = (msg: string) =>
    redirect(`/guide-editor/${params.id}?notice=${encodeURIComponent(msg)}`);
  try {
    const intent = get("intent");
    if (intent === "preview") {
      // The same renderer the guide page uses, on the unsaved text.
      if (!(await editorGuide(db, params.id))) {
        throw data({ reason: "guide_not_found" }, { status: 404 });
      }
      return { preview: renderGuide(values.body), values };
    }
    if (intent === "delete") {
      await deleteGuide(db, viewer, params.id);
      return redirect(`/guide-editor?notice=${encodeURIComponent("Draft deleted.")}`);
    }
    await saveGuide(db, viewer, params.id, values);
    if (intent === "save_publish") {
      await setPublished(db, viewer, params.id, true);
      return back("Saved and published.");
    }
    if (intent === "unpublish") {
      await setPublished(db, viewer, params.id, false);
      return back("Saved. It's a draft again.");
    }
    return back("Saved.");
  } catch (e) {
    // A guide that isn't this camp's (or no longer exists) is a 404 page, not a form error.
    if (reasonOf(e) === "guide_not_found") throw e;
    return { ...formError(e), values };
  }
}

export default function EditGuide({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const saved = loaderData.guide;
  // After a preview (or a refused save), the form keeps what was typed.
  const v = actionData && "values" in actionData && actionData.values ? actionData.values : saved;
  const preview = actionData && "preview" in actionData ? (actionData.preview ?? null) : null;
  const error = actionData && "error" in actionData ? actionData.error : null;
  return (
    <section className="max-w-3xl space-y-5">
      <Link to="/guide-editor" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Guide editor
      </Link>
      <PageHeader title={saved.title}>
        {saved.published && (
          <Link to={`/guides/${saved.slug}`} className={btn.secondary}>
            View
          </Link>
        )}
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-sm text-charcoal">
        {saved.published ? "Published" : "Draft: only Leads and Admins can see it here."}{" "}
        {`Address: /guides/${saved.slug}`}
      </p>

      <Form
        method="post"
        key={preview ? "after-preview" : "saved"}
        className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light"
      >
        <Field label="Title">
          <input
            name="title"
            defaultValue={v.title}
            required
            maxLength={TITLE_MAX}
            className={input}
          />
        </Field>
        <Field label="Summary (optional)" hint="One line shown in the list of guides.">
          <input
            name="summary"
            defaultValue={v.summary}
            maxLength={SUMMARY_MAX}
            className={input}
          />
        </Field>
        <Field label="Who can read it">
          <select name="visibility" defaultValue={v.visibility} className={input}>
            <option value="public">Everyone, without signing in</option>
            <option value="members">Camp members</option>
            <option value="leads">Leads and Admins</option>
          </select>
        </Field>
        <Field
          label="Guide"
          hint="Markdown: # Heading, **bold**, *italic*, - lists, [link text](/rsvp) or [text](https://…). HTML and images aren't shown."
        >
          <textarea
            name="body"
            defaultValue={v.body}
            rows={18}
            maxLength={BODY_MAX}
            className={`${input} font-mono text-sm`}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button type="submit" name="intent" value="save" className={btn.primary}>
            Save
          </button>
          <button type="submit" name="intent" value="preview" className={btn.secondary}>
            Preview
          </button>
          {saved.published ? (
            <button type="submit" name="intent" value="unpublish" className={btn.secondary}>
              Save as draft (unpublish)
            </button>
          ) : (
            <button type="submit" name="intent" value="save_publish" className={btn.secondary}>
              Save and publish
            </button>
          )}
        </div>
      </Form>

      {preview !== null && (
        <div className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-charcoal">
            Preview (not saved yet)
          </h2>
          <article className="guide">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by markdown.server.ts */}
            <div dangerouslySetInnerHTML={{ __html: preview }} />
          </article>
        </div>
      )}

      {!saved.published && (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm("Delete this draft? This can't be undone.")) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <button type="submit" className="text-sm text-coral-ink underline">
            Delete this draft
          </button>
        </Form>
      )}
    </section>
  );
}
