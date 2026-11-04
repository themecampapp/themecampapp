// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import {
  copyStarter,
  createGuide,
  editorList,
  moveGuide,
  setPublished,
} from "~/lib/data/guides.server";
import { STARTERS } from "~/lib/data/starters.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.lead.guides._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Guide editor") }];
}

// The camp's guides, drafts included, in their order (R28). Leads and Admins only, via the
// Lead layout.
export async function loader({ context }: Route.LoaderArgs) {
  const guides = await editorList(getDb(context));
  const have = new Set(guides.map((g) => g.slug));
  return {
    guides: guides.map((g) => ({ ...g, updatedAt: g.updatedAt.toISOString() })),
    // R30: the ready-made guides, and which this camp already has an address for.
    starters: STARTERS.map((st) => ({
      slug: st.slug,
      title: st.title,
      summary: st.summary,
      visibility: st.visibility,
      have: have.has(st.slug),
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) => redirect(`/guide-editor?notice=${encodeURIComponent(msg)}`);
  try {
    switch (get("intent")) {
      case "create": {
        const { id } = await createGuide(db, viewer, {
          title: get("title"),
          summary: "",
          body: "",
          visibility: "members",
        });
        return redirect(`/guide-editor/${id}`);
      }
      case "copy_starter": {
        const { id } = await copyStarter(
          db,
          viewer,
          get("slug"),
          context.get(cloudflareContext).env.PRODUCT_NAME,
        );
        return redirect(
          `/guide-editor/${id}?notice=${encodeURIComponent("Copied as a draft. Make it your camp's own, then publish it.")}`,
        );
      }
      case "up":
      case "down":
        await moveGuide(db, viewer, get("id"), get("intent") as "up" | "down");
        return done("Order saved.");
      case "publish":
      case "unpublish":
        await setPublished(db, viewer, get("id"), get("intent") === "publish");
        return done(get("intent") === "publish" ? "Guide published." : "Guide unpublished.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

const VISIBILITY = { public: "Everyone", members: "Members", leads: "Leads" } as const;

export default function GuideEditor({ loaderData, actionData }: Route.ComponentProps) {
  const { guides, starters } = loaderData;
  const [params] = useSearchParams();
  return (
    <section className="max-w-3xl space-y-5">
      <PageHeader title="Guide editor">
        <Link to="/guides" className={btn.secondary}>
          View guides
        </Link>
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        Guides explain how your camp works. Write them in Markdown; members see only published
        guides, in this order. "Everyone" guides can be read without signing in.
      </p>

      {guides.length === 0 ? (
        <Notice>No guides yet. Start one below.</Notice>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
          {guides.map((g, i) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <Link to={`/guide-editor/${g.id}`} className="font-semibold underline">
                  {g.title}
                </Link>
                <span className="block text-xs text-charcoal">
                  {`${g.published ? "Published" : "Draft"} · ${VISIBILITY[g.visibility]} · /guides/${g.slug}`}
                </span>
              </div>
              <Form method="post" className="flex gap-1">
                <input type="hidden" name="id" value={g.id} />
                <button
                  type="submit"
                  name="intent"
                  value="up"
                  disabled={i === 0}
                  aria-label={`Move ${g.title} up`}
                  className={btn.secondary}
                >
                  ↑
                </button>
                <button
                  type="submit"
                  name="intent"
                  value="down"
                  disabled={i === guides.length - 1}
                  aria-label={`Move ${g.title} down`}
                  className={btn.secondary}
                >
                  ↓
                </button>
                <button
                  type="submit"
                  name="intent"
                  value={g.published ? "unpublish" : "publish"}
                  className={btn.secondary}
                >
                  {g.published ? "Unpublish" : "Publish"}
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">New guide</h2>
        <input type="hidden" name="intent" value="create" />
        <Field label="Title" hint="Its web address comes from the title and doesn't change.">
          <input name="title" required maxLength={120} className={input} />
        </Field>
        <button type="submit" className={btn.primary}>
          Start a draft
        </button>
      </Form>

      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Start from a ready-made guide</h2>
        <p className="text-sm text-charcoal">
          General guides most camps need. Copying one makes a draft here for you to edit (the parts
          to fill in are marked "Edit this"), then publish. Pages across the app link to these
          guides once they're published.
        </p>
        <ul className="divide-y divide-dust-light">
          {starters.map((st) => (
            <li key={st.slug} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="font-semibold">{st.title}</span>
                <span className="block text-xs text-charcoal">
                  {`${VISIBILITY[st.visibility]} · ${st.summary}`}
                </span>
              </div>
              {st.have ? (
                <span className="text-xs text-charcoal">{`You have /guides/${st.slug}`}</span>
              ) : (
                <Form method="post">
                  <input type="hidden" name="intent" value="copy_starter" />
                  <input type="hidden" name="slug" value={st.slug} />
                  <button type="submit" className={btn.secondary}>
                    Copy as a draft
                  </button>
                </Form>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
