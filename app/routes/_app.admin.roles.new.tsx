// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { AreaLevelPicker } from "~/components/AreaLevelPicker";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { createRole } from "~/lib/data/camp-roles.server";
import { formError } from "~/lib/errors";
import { grantsFromForm, STARTING_POINTS } from "~/lib/permissions";
import type { Route } from "./+types/_app.admin.roles.new";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "New role · Admin") }];
}

// Issue #93: a new custom role, starting from a built-in role, a ready-made one, or nothing.
export async function loader({ request, context }: Route.LoaderArgs) {
  const asked = new URL(request.url).searchParams.get("start");
  const start = STARTING_POINTS.find((s) => s.key === asked) ?? STARTING_POINTS[0];
  const viewer = getViewer(context);
  return {
    features: (await getSettings(context)).features,
    start: start.key,
    // The demo and support access look, but can't change anything.
    readOnly: !!viewer.demo || !!viewer.support,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "");
  const description = String(form.get("description") ?? "");
  const grants = grantsFromForm((k) => form.get(k));
  try {
    await createRole(getDb(context), getViewer(context), { name, description, grants });
  } catch (e) {
    return { ...formError(e), values: { name, description, grants } };
  }
  return redirect(`/admin/roles?notice=${encodeURIComponent(`Created the ${name.trim()} role.`)}`);
}

export default function NewRole({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const start = STARTING_POINTS.find((s) => s.key === loaderData.start) ?? STARTING_POINTS[0];
  const values = actionData?.values;
  return (
    <section className="max-w-2xl space-y-5">
      <Link to="/admin/roles" className="text-sm underline">
        ← Roles
      </Link>
      <PageHeader title="New role" />
      <div className="space-y-2">
        <p className="text-sm font-medium">Start from</p>
        <div className="flex flex-wrap gap-2 text-sm">
          {STARTING_POINTS.map((s) => (
            <Link
              key={s.key}
              to={`?start=${s.key}`}
              replace
              preventScrollReset
              className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${s.key === start.key ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>
      <Form method="post" className="space-y-5 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
        <Field label="Name" hint="For example: Tickets coordinator, Registrar, Kitchen lead.">
          <input
            name="name"
            required
            maxLength={40}
            defaultValue={values?.name ?? ""}
            className={input}
          />
        </Field>
        <Field label="Description (optional)" hint="What this person does for the camp.">
          <input
            name="description"
            maxLength={200}
            defaultValue={values?.description ?? ""}
            className={input}
          />
        </Field>
        <AreaLevelPicker
          key={params.get("start") ?? start.key}
          initial={values?.grants ?? start.access}
          features={loaderData.features}
        />
        {!loaderData.readOnly && (
          <button type="submit" className={btn.primary}>
            Create role
          </button>
        )}
      </Form>
    </section>
  );
}
