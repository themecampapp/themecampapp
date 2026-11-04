// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { btn, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { campRoles, confirmRolesReviewed, type RoleCard } from "~/lib/data/camp-roles.server";
import { formError } from "~/lib/errors";
import { accessSummary, MAX_CUSTOM_ROLES } from "~/lib/permissions";
import type { Route } from "./+types/_app.admin.roles._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Roles · Admin") }];
}

// Issue #93: the camp's roles and what each can do. Admins only, via the admin layout.
export async function loader({ context }: Route.LoaderArgs) {
  const { features, setup } = await getSettings(context);
  const viewer = getViewer(context);
  const roles = await campRoles(getDb(context));
  const summarize = (r: RoleCard) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    builtin: r.builtin,
    customized: r.customized,
    review: r.newAreas.length > 0,
    summary: accessSummary(r.access, features),
    holders: r.holders.map((h) => h.name),
  });
  return {
    builtins: roles.builtins.map(summarize),
    custom: roles.custom.map(summarize),
    archived: roles.archived.map(summarize),
    admins: roles.admins.map((h) => h.name),
    canAdd: roles.custom.length < MAX_CUSTOM_ROLES,
    // The setup checklist's "Review what your Leads can see", until an Admin has.
    askReview: !setup.rolesReviewed && !viewer.demo && !viewer.support,
  };
}

// "These look right": ticks the setup checklist item without changing a role.
export async function action({ context }: Route.ActionArgs) {
  try {
    await confirmRolesReviewed(getDb(context), getViewer(context));
  } catch (e) {
    return formError(e);
  }
  return redirect(
    `/admin/roles?notice=${encodeURIComponent("Thanks. You can change any role later.")}`,
  );
}

type Card = Route.ComponentProps["loaderData"]["custom"][number];

function Holders({ names }: { names: string[] }) {
  return (
    <p className="text-sm text-charcoal">
      {names.length ? `Held by ${names.join(", ")}` : "No one has this role yet."}
    </p>
  );
}

function RoleRow({ role, edit = true }: { role: Card; edit?: boolean }) {
  return (
    <li className="space-y-1 rounded-xl bg-white p-4 ring-1 ring-dust-light">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{role.name}</h2>
        {role.customized && (
          <span className="rounded-full bg-dust-pale px-2 py-0.5 text-xs">Customized</span>
        )}
        {role.review && (
          <span className="rounded-full bg-gold-glow px-2 py-0.5 text-xs">New area: review</span>
        )}
        {edit && (
          <Link to={`/admin/roles/${role.key}`} className="ml-auto text-sm underline">
            Edit
          </Link>
        )}
      </div>
      {role.description && <p className="text-sm">{role.description}</p>}
      <p className="text-sm">{role.summary}</p>
      <Holders names={role.holders} />
    </li>
  );
}

export default function Roles({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const { builtins, custom, archived, admins } = loaderData;
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Roles">
        {loaderData.canAdd && (
          <Link to="/admin/roles/new" className={btn.primary}>
            New role
          </Link>
        )}
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {loaderData.askReview && (
        <Form method="post" className="space-y-3 rounded-xl bg-gold-glow p-4 ring-1 ring-gold">
          <p className="text-sm">
            Before you give people roles, check what Lead and Treasurer can do in your camp, and
            especially who sees members' private details. Change either one with Edit, or confirm
            they're right as they are.
          </p>
          <button type="submit" className={btn.primary}>
            These look right
          </button>
        </Form>
      )}
      <p className="text-sm text-charcoal">
        What each role can do in the camp's tools. Someone with more than one role can do what any
        of them allows. Only Admins give people roles, on each person's page under People.
      </p>
      <ul className="space-y-3">
        <li className="space-y-1 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">Member</h2>
          <p className="text-sm text-charcoal">
            Everyone in the camp: their own RSVP, profile, ticket request and dues, the Yearbook,
            the directory and the guides.
          </p>
        </li>
        {builtins.map((r) => (
          <RoleRow key={r.key} role={r} />
        ))}
        <li className="space-y-1 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">Admin</h2>
          <p className="text-sm">
            Everything, including the Admin pages. Admin can't be changed, so the camp always has
            someone who can do it all.
          </p>
          <Holders names={admins} />
        </li>
        {custom.map((r) => (
          <RoleRow key={r.key} role={r} />
        ))}
      </ul>
      {custom.length === 0 && (
        <p className="text-sm text-charcoal">
          No custom roles yet. Make one for a job that needs some of the tools but not all, like a
          tickets coordinator or a registrar.
        </p>
      )}
      {archived.length > 0 && (
        <details className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <summary className="cursor-pointer font-medium">{`Archived roles (${archived.length})`}</summary>
          <ul className="mt-3 space-y-2">
            {archived.map((r) => (
              <li key={r.key} className="text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="text-charcoal">{` · ${r.summary}`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
