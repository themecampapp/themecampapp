// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { asc, eq, sql } from "drizzle-orm";
import { Form, Link, redirect, useSearchParams } from "react-router";
import { PersonLink } from "~/components/PersonLink";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { person } from "~/db/schema";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { pageTexts, savePageText } from "~/lib/data/page-text.server";
import { currentYear } from "~/lib/data/participation.server";
import {
  addRole,
  comingWithoutRole,
  leadAddSignup,
  leadRemoveSignup,
  listRoles,
  openFirst,
  type RoleView,
  saveVolunteerMax,
  setRoleRetired,
  updateRole,
} from "~/lib/data/volunteer.server";
import { formError } from "~/lib/errors";
import { grantRole } from "~/lib/roles.server";
import type { Route } from "./+types/_app.lead.volunteers";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Manage jobs") }];
}

// Managing the camp's jobs (issue #106): edit the list, add or remove anyone (past a job's
// slots too), and fill the jobs only Leads assign, such as the former elected positions. Members
// sign up for the others themselves at /volunteer. Admins can make someone in a job a Lead.
export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const people = await db
    .select({ id: person.id, playaName: person.playaName, legalName: person.legalName })
    .from(person)
    .where(eq(person.active, true))
    .orderBy(asc(sql`lower(coalesce(${person.playaName}, ${person.legalName}))`));
  return {
    year: await currentYear(db),
    // Issue #29: what members are asked to do, and the most jobs each may take. Admins change
    // them here; every Lead sees them.
    isAdmin: viewer.isAdmin === true,
    instructions: (await pageTexts(db, ["volunteer_instructions"])).volunteer_instructions,
    max: (await getSettings(context)).volunteerMaxRoles,
    // Jobs that still need people first. Who's a Lead goes only to Admins (for Make Lead):
    // seeing jobs doesn't mean seeing everyone's roles.
    roles: openFirst(await listRoles(db, viewer.personId, { includeRetired: true })).map((r) => ({
      ...r,
      signups: r.signups.map(({ isLead, ...s }) => (viewer.isAdmin ? { ...s, isLead } : s)),
    })),
    // Staffing: who's coming but has no job yet.
    unassigned: [...(await comingWithoutRole(db))],
    people: people.map((p) => ({
      id: p.id,
      name: p.playaName ? `${p.playaName} (${p.legalName})` : p.legalName,
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const role = () => ({
    title: get("title"),
    commitment: get("commitment"),
    description: get("description"),
    slots: get("slots"),
    selfSignup: form.get("selfSignup") === "1",
    showInYearbook: form.get("showInYearbook") === "1",
  });
  const done = (msg: string) => redirect(`/volunteers?notice=${encodeURIComponent(msg)}`);
  try {
    switch (get("intent")) {
      case "member_rules": {
        const problem = await savePageText(
          db,
          viewer,
          "volunteer_instructions",
          get("instructions"),
        );
        if (problem) return { error: problem };
        await saveVolunteerMax(db, viewer, get("max"));
        return done("Saved what members see.");
      }
      case "add_person":
        if (!get("personId")) return { error: "Pick someone to add." };
        await leadAddSignup(db, viewer, get("roleId"), get("personId"));
        return done("Added.");
      case "remove_person":
        await leadRemoveSignup(db, viewer, get("roleId"), get("personId"));
        return done("Removed.");
      case "update":
        await updateRole(db, viewer, get("roleId"), role());
        return done("Job saved.");
      case "add_role":
        await addRole(db, viewer, role());
        return done("Job added.");
      case "retire":
      case "restore":
        await setRoleRetired(db, viewer, get("roleId"), get("intent") === "retire");
        return done(get("intent") === "retire" ? "Job retired." : "Job restored.");
      // Admins only (grantRole checks): for camps whose job holders run the camp.
      case "make_lead":
        await grantRole(db, viewer, get("personId"), "lead");
        return done("Made a Lead.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

function RoleFields({ r }: { r?: Omit<RoleView, "signups"> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
      <Field label="Job">
        <input name="title" defaultValue={r?.title ?? ""} required className={input} />
      </Field>
      <Field label="Spots">
        <input
          name="slots"
          type="number"
          min={1}
          max={50}
          defaultValue={r?.slots ?? 1}
          className={input}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Time commitment" hint="e.g. 2–3 hrs a month before the burn">
          <input name="commitment" defaultValue={r?.commitment ?? ""} className={input} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Description">
          <textarea
            name="description"
            rows={2}
            defaultValue={r?.description ?? ""}
            className={input}
          />
        </Field>
      </div>
      <div className="space-y-2 text-sm sm:col-span-2">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="selfSignup"
            value="1"
            defaultChecked={r?.selfSignup ?? true}
            className="mt-1"
          />
          <span>Members can sign up themselves (untick for jobs only Leads fill)</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="showInYearbook"
            value="1"
            defaultChecked={r?.showInYearbook ?? false}
            className="mt-1"
          />
          <span>Show in the Yearbook's Who's who</span>
        </label>
      </div>
    </div>
  );
}

export default function ManageVolunteers({ loaderData, actionData }: Route.ComponentProps) {
  const { roles, people, year, isAdmin, instructions, max } = loaderData;
  const [params] = useSearchParams();
  const active = roles.filter((r) => !r.retired);
  const { unassigned } = loaderData;
  const retired = roles.filter((r) => r.retired);
  const unfilled = active.reduce((n, r) => n + Math.max(0, r.slots - r.signups.length), 0);
  return (
    <section className="max-w-3xl space-y-5">
      <Link to="/volunteer" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Jobs
      </Link>
      <PageHeader title={`Manage ${year} jobs`} />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        The job list carries over each year; who's in each job starts fresh at rollover. You can add
        people past a job's spots, and fill the jobs members can't sign up for.
      </p>

      <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-gold">
        <h2 className="font-semibold">Staffing</h2>
        <p className="text-sm">
          {`${unfilled} open ${unfilled === 1 ? "spot" : "spots"} across ${active.length} jobs · ${unassigned.length} coming ${unassigned.length === 1 ? "camper" : "campers"} without a job. ${max === null ? "Members can sign up for as many jobs as they like." : `Members can sign up for up to ${max} ${max === 1 ? "job" : "jobs"} each.`}`}
        </p>
        {unassigned.length > 0 && (
          <p className="text-sm">
            {unassigned.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <PersonLink id={p.id} className="underline">
                  {p.name}
                </PersonLink>
              </span>
            ))}
          </p>
        )}
      </div>

      {isAdmin && (
        <details className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <summary className="cursor-pointer font-semibold">What members see (Admins)</summary>
          <Form method="post" className="mt-3 space-y-3">
            <input type="hidden" name="intent" value="member_rules" />
            <Field
              label="Volunteer instructions"
              hint="At the top of the jobs page, and on members' home page until they have a job. For example: pick 2 or more jobs, or take one unless you're already a Lead. Also under Admin → Page wording."
            >
              <textarea
                name="instructions"
                defaultValue={instructions}
                rows={3}
                maxLength={400}
                required
                className={input}
              />
            </Field>
            <Field
              label="Most jobs per member"
              hint="Leave blank for no limit. Counts only jobs members pick themselves. Leads can still add them here."
            >
              <div className="w-24">
                <input
                  name="max"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={max ?? ""}
                  className={input}
                />
              </div>
            </Field>
            <button type="submit" className={btn.primary}>
              Save
            </button>
          </Form>
        </details>
      )}

      <ul className="space-y-3">
        {active.map((r) => (
          <li key={r.id} className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">{r.title}</h2>
              <span className="text-sm">{`${r.signups.length} of ${r.slots} filled`}</span>
            </div>
            <p className="text-xs text-charcoal">
              {r.selfSignup ? "Members can sign up" : "Leads fill this job"}
              {r.showInYearbook && " · In Who's who"}
            </p>
            {r.signups.length > 0 && (
              <ul className="flex flex-wrap gap-2 text-sm">
                {r.signups.map((s) => (
                  <li
                    key={s.personId}
                    className="flex items-center gap-2 rounded-full bg-dust-pale px-3 py-1 ring-1 ring-dust"
                  >
                    <PersonLink id={s.personId} className="underline">
                      {s.name}
                    </PersonLink>
                    {isAdmin && "isLead" in s && !s.isLead && (
                      <Form method="post" className="flex items-center gap-1 text-charcoal">
                        <input type="hidden" name="intent" value="make_lead" />
                        <input type="hidden" name="personId" value={s.personId} />
                        <span>Not a Lead ·</span>
                        <button type="submit" className="underline">
                          Make Lead
                        </button>
                      </Form>
                    )}
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_person" />
                      <input type="hidden" name="roleId" value={r.id} />
                      <input type="hidden" name="personId" value={s.personId} />
                      <button
                        type="submit"
                        aria-label={`Remove ${s.name}`}
                        className="text-coral-ink pointer-coarse:px-2 pointer-coarse:py-1.5"
                      >
                        ×
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            )}
            <Form method="post" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="intent" value="add_person" />
              <input type="hidden" name="roleId" value={r.id} />
              <select
                name="personId"
                defaultValue=""
                aria-label={`Add someone to ${r.title}`}
                className={`${input} w-auto max-w-72`}
              >
                <option value="">Add someone…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button type="submit" className={btn.secondary}>
                Add
              </button>
            </Form>
            <details>
              <summary className="cursor-pointer text-sm underline">Edit job</summary>
              <Form method="post" className="mt-3 space-y-3">
                <input type="hidden" name="intent" value="update" />
                <input type="hidden" name="roleId" value={r.id} />
                <RoleFields r={r} />
                <button type="submit" className={btn.secondary}>
                  Save
                </button>
              </Form>
              <Form method="post" className="mt-2">
                <input type="hidden" name="intent" value="retire" />
                <input type="hidden" name="roleId" value={r.id} />
                <button type="submit" className="text-sm underline">
                  Retire job
                </button>
              </Form>
            </details>
          </li>
        ))}
      </ul>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Add a job</h2>
        <input type="hidden" name="intent" value="add_role" />
        <RoleFields />
        <button type="submit" className={btn.primary}>
          Add job
        </button>
      </Form>

      {retired.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">Retired jobs</h2>
          <ul className="flex flex-wrap gap-3 text-sm">
            {retired.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                {r.title}
                <Form method="post">
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="roleId" value={r.id} />
                  <button type="submit" className="underline">
                    restore
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
