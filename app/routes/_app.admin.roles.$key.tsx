// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, Link, redirect } from "react-router";
import { AreaLevelPicker } from "~/components/AreaLevelPicker";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import {
  archiveRole,
  findCampRole,
  lowered,
  resetRole,
  saveRole,
} from "~/lib/data/camp-roles.server";
import { formError } from "~/lib/errors";
import { BUILTIN_DEFAULTS, grantsFromForm } from "~/lib/permissions";
import type { Route } from "./+types/_app.admin.roles.$key";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${loaderData?.role.name ?? "Role"} · Admin`) }];
}

// Issue #93: one role's levels. Lead and Treasurer can be reset to the defaults; a custom role
// has a name and description, and can be archived.
export async function loader({ params, context }: Route.LoaderArgs) {
  const role = await findCampRole(getDb(context), params.key);
  if (!role || role.archived) throw data({ reason: "not_found" }, { status: 404 });
  const viewer = getViewer(context);
  return {
    role: {
      key: role.key,
      builtin: role.builtin,
      name: role.name,
      description: role.description,
      access: role.access,
      customized: role.customized,
      newAreas: role.newAreas,
      holders: role.holders.map((h) => h.name),
    },
    // What resetting a customized Lead or Treasurer would take away from its holders.
    resetLoses:
      role.builtin && role.customized ? lowered(role.access, BUILTIN_DEFAULTS[role.builtin]) : [],
    features: (await getSettings(context)).features,
    // The demo and support access look, but can't change anything.
    readOnly: !!viewer.demo || !!viewer.support,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const db = getDb(context);
  const viewer = getViewer(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const back = (msg: string) => redirect(`/admin/roles?notice=${encodeURIComponent(msg)}`);
  const key = params.key;
  // Only this camp's roles exist here: anything else is a 404, never a quiet no-op.
  if (!(await findCampRole(db, key))) throw data({ reason: "not_found" }, { status: 404 });
  try {
    if (intent === "reset") {
      if (key !== "lead" && key !== "treasurer")
        throw data({ reason: "not_found" }, { status: 404 });
      await resetRole(db, viewer, key);
      return back(`${key === "lead" ? "Lead" : "Treasurer"} is back to the defaults.`);
    }
    if (intent === "archive") {
      await archiveRole(db, viewer, key);
      return back("Role archived.");
    }
    const values = {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
      grants: grantsFromForm((k) => form.get(k)),
    };
    const result = await saveRole(db, viewer, key, {
      ...values,
      confirmed: form.get("confirmed") === "1",
    });
    if (!result.ok) return { confirm: { lost: result.lost, holders: result.holders }, values };
    return back("Role saved. It applies from each person's next page.");
  } catch (e) {
    return formError(e);
  }
}

export default function EditRole({ loaderData, actionData }: Route.ComponentProps) {
  const { role, features, readOnly } = loaderData;
  const values = actionData && "values" in actionData ? actionData.values : undefined;
  const confirm = actionData && "confirm" in actionData ? actionData.confirm : undefined;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  return (
    <section className="max-w-2xl space-y-5">
      <Link to="/admin/roles" className="text-sm underline">
        ← Roles
      </Link>
      <PageHeader title={role.name} />
      <p className="text-sm text-charcoal">
        {role.holders.length
          ? `Held by ${role.holders.join(", ")}. Changes apply from each person's next page.`
          : "No one has this role yet."}
      </p>
      {role.newAreas.length > 0 && (
        <Notice>
          This role was saved before some areas existed, so it gives no access in them yet. Check
          those rows and save.
        </Notice>
      )}
      <Form method="post" className="space-y-5 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        {error && <Notice tone="error">{error}</Notice>}
        <input type="hidden" name="intent" value="save" />
        {!role.builtin && (
          <>
            <Field label="Name">
              <input
                name="name"
                required
                maxLength={40}
                defaultValue={values?.name ?? role.name}
                disabled={readOnly}
                className={input}
              />
            </Field>
            <Field label="Description (optional)">
              <input
                name="description"
                maxLength={200}
                defaultValue={values?.description ?? role.description}
                disabled={readOnly}
                className={input}
              />
            </Field>
          </>
        )}
        <AreaLevelPicker
          // Starts again from what's shown whenever that changes (a cancelled warning goes back
          // to what the role saves).
          key={JSON.stringify(values?.grants ?? role.access)}
          initial={values?.grants ?? role.access}
          features={features}
          disabled={readOnly}
        />
        {confirm ? (
          <div className="space-y-3 rounded-lg bg-coral/10 p-3 text-sm ring-1 ring-coral/40">
            <p>
              {`This takes away ${confirm.lost.join(", ")} from ${confirm.holders.join(", ")}. They'll notice on their next page.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" name="confirmed" value="1" className={btn.danger}>
                Save anyway
              </button>
              <Link to="." className={btn.secondary}>
                Cancel
              </Link>
            </div>
          </div>
        ) : (
          !readOnly && (
            <button type="submit" className={btn.primary}>
              Save role
            </button>
          )
        )}
      </Form>
      {!readOnly && role.builtin && role.customized && (
        <details className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <summary className="cursor-pointer font-medium">Reset to the defaults</summary>
          <Form method="post" className="mt-3 space-y-3">
            <input type="hidden" name="intent" value="reset" />
            <p className="text-sm text-charcoal">
              {`${role.name} goes back to what it allows out of the box. Your changes to it are recorded in the Activity log.`}
            </p>
            {loaderData.resetLoses.length > 0 && role.holders.length > 0 && (
              <p className="text-sm text-coral-ink">
                {`This takes away ${loaderData.resetLoses.join(", ")} from ${role.holders.join(", ")}.`}
              </p>
            )}
            <button type="submit" className={btn.secondary}>
              {`Reset ${role.name}`}
            </button>
          </Form>
        </details>
      )}
      {!readOnly && !role.builtin && (
        <details className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <summary className="cursor-pointer font-medium">Archive this role</summary>
          <Form method="post" className="mt-3 space-y-3">
            <input type="hidden" name="intent" value="archive" />
            <p className="text-sm text-charcoal">
              {role.holders.length
                ? `${role.holders.join(", ")} will lose this role right away. It stays in the camp's history, and its name can be used again.`
                : "It stays in the camp's history, and its name can be used again."}
            </p>
            <button type="submit" className={btn.danger}>
              Archive role
            </button>
          </Form>
        </details>
      )}
    </section>
  );
}
