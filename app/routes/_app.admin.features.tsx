// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { btn, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import { getCampSettings, saveFeatures } from "~/lib/data/camp-settings.server";
import { formError } from "~/lib/errors";
import { FEATURES, type FeatureKey } from "~/lib/features";
import type { Route } from "./+types/_app.admin.features";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Features · Admin") }];
}

// Which optional parts of the app this camp uses (R20). Admins only, via the admin layout.
export async function loader({ context }: Route.LoaderArgs) {
  return { features: (await getCampSettings(getDb(context))).features };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const on = new Set(
    form
      .getAll("on")
      .map(String)
      .filter((k): k is FeatureKey => FEATURES.some((f) => f.key === k)),
  );
  try {
    await saveFeatures(getDb(context), getViewer(context), on);
  } catch (e) {
    return formError(e);
  }
  return redirect(`/admin/features?notice=${encodeURIComponent("Features saved.")}`);
}

export default function Features({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Features" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      <p className="text-sm text-charcoal">
        Turn on the parts of the app your camp uses. Turning one off hides its pages and emails but
        keeps its data, so turning it back on brings everything back. RSVPs, Stewards Sale ticket
        requests and guides are always on.
      </p>
      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
        {FEATURES.map((f) => (
          <label key={f.key} className="flex items-start gap-3">
            <input
              type="checkbox"
              name="on"
              value={f.key}
              defaultChecked={loaderData.features[f.key]}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">{f.label}</span>
              <span className="block text-sm text-charcoal">{f.description}</span>
            </span>
          </label>
        ))}
        <button type="submit" className={btn.primary}>
          Save features
        </button>
      </Form>
    </section>
  );
}
