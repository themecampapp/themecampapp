// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { listPageTexts, resetPageText, savePageText } from "~/lib/data/page-text.server";
import type { Route } from "./+types/_app.admin.wording";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Page wording · Admin") }];
}

// Issue #56: the instructions on members' pages that each camp words its own way. Texts for a
// switched-off feature aren't listed (they aren't shown anywhere).
export async function loader({ context }: Route.LoaderArgs) {
  const { features } = await getSettings(context);
  const texts = await listPageTexts(getDb(context));
  return { texts: texts.filter((t) => !t.feature || features[t.feature]) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const db = getDb(context);
  const viewer = getViewer(context);
  const form = await request.formData();
  const key = String(form.get("key") ?? "");
  if (form.get("intent") === "reset") {
    await resetPageText(db, viewer, key);
    return redirect(
      `/admin/wording?notice=${encodeURIComponent("Back to the default wording.")}#${key}`,
    );
  }
  const problem = await savePageText(db, viewer, key, String(form.get("text") ?? ""));
  if (problem) return { error: problem, key };
  return redirect(`/admin/wording?notice=${encodeURIComponent("Saved.")}#${key}`);
}

export default function Wording({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const pages = [...new Set(loaderData.texts.map((t) => t.page))];
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Page wording" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      <p className="text-sm text-charcoal">
        Instructions members see on the camp app's pages, in your camp's words. Plain text: you can
        use {"{camp}"} and {"{year}"}, and full https:// links show as typed. Reset any of them to
        go back to the default.
      </p>
      {pages.map((page) => (
        <div key={page} className="space-y-3">
          <h2 className="font-semibold">{page}</h2>
          {loaderData.texts
            .filter((t) => t.page === page)
            .map((t) => (
              <Form
                key={t.key}
                id={t.key}
                method="post"
                className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light"
              >
                <input type="hidden" name="key" value={t.key} />
                {actionData?.key === t.key && <Notice tone="error">{actionData.error}</Notice>}
                <Field
                  label={t.name}
                  hint={`${t.where}${t.optional ? " Leave it empty to show nothing." : ""}`}
                >
                  <textarea
                    name="text"
                    defaultValue={t.current}
                    rows={3}
                    maxLength={t.max}
                    required={!t.optional}
                    className={input}
                  />
                </Field>
                {t.customizedAt && (
                  <p className="text-xs text-charcoal">{`Default: ${t.default}`}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" className={btn.primary}>
                    Save
                  </button>
                  {t.customizedAt && (
                    <button
                      type="submit"
                      name="intent"
                      value="reset"
                      formNoValidate
                      className={btn.secondary}
                    >
                      Reset to default
                    </button>
                  )}
                  <span className="text-xs text-charcoal">
                    {t.customizedAt
                      ? `Edited ${new Date(t.customizedAt).toLocaleDateString()}`
                      : "Default wording"}
                  </span>
                </div>
              </Form>
            ))}
        </div>
      ))}
    </section>
  );
}
