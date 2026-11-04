// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { useHasGuide } from "~/components/GuideLink";
import { PageText } from "~/components/PageText";
import { btn, Notice, PageHeader } from "~/components/ui";
import { can, getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { currentYear } from "~/lib/data/participation.server";
import { leaveRole, listRoles, openFirst, pickedCount, signUp } from "~/lib/data/volunteer.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.volunteer";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Jobs") }];
}

// The camp's jobs (issue #106). Members sign up for jobs open to sign-up while they have open
// slots, up to the camp's limit of jobs per member if it has one (issue #29), which counts only
// the jobs they picked. Jobs Leads fill are listed too, with who's in them. The instructions are
// the camp's own wording.
export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  // Jobs that still need people come first.
  const roles = openFirst(await listRoles(db, viewer.personId));
  const { volunteerMaxRoles, features } = await getSettings(context);
  return {
    year: await currentYear(db),
    canManage: can(viewer, "volunteer", "manage"),
    instructions: (await pageTexts(db, ["volunteer_instructions"])).volunteer_instructions,
    max: volunteerMaxRoles,
    picked: await pickedCount(db, viewer.personId),
    // Names only (Yearbook labels): no person ids go to the page. Who's in a job only Leads
    // fill is shown only when that job is in the Yearbook's Who's who (and the Yearbook is on),
    // as elected positions were before issue #106; otherwise just how full it is. Members
    // always see who signed up for the jobs open to sign-up.
    roles: roles.map((r) => ({
      id: r.id,
      title: r.title,
      commitment: r.commitment,
      description: r.description,
      slots: r.slots,
      selfSignup: r.selfSignup,
      full: r.full,
      mine: r.mine,
      filled: r.signups.length,
      names:
        r.selfSignup || (r.showInYearbook && features.yearbook)
          ? r.signups.map((s) => s.label)
          : [],
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const roleId = String(form.get("roleId") ?? "");
  const title = String(form.get("title") ?? "the job");
  try {
    if (form.get("intent") === "leave") {
      await leaveRole(db, viewer, roleId);
      return redirect(`/volunteer?notice=${encodeURIComponent(`You've left ${title}.`)}`);
    }
    await signUp(db, viewer, roleId);
    return redirect(
      `/volunteer?notice=${encodeURIComponent(`You're signed up for ${title}. Thank you!`)}`,
    );
  } catch (e) {
    return formError(e);
  }
}

export default function Volunteer({ loaderData, actionData }: Route.ComponentProps) {
  const volunteerGuide = useHasGuide("volunteer");
  const { roles, year, canManage, instructions, max, picked } = loaderData;
  const [params] = useSearchParams();
  const mine = roles.filter((r) => r.mine);
  const open = roles.filter((r) => r.selfSignup);
  const assigned = roles.filter((r) => !r.selfSignup);
  const atMax = max !== null && picked >= max;
  const jobs = (n: number) => (n === 1 ? "job" : "jobs");
  return (
    <section className="max-w-3xl space-y-5">
      <PageHeader title={`${year} jobs`}>
        {canManage && (
          <Link to="/volunteers" className={btn.secondary}>
            Manage jobs
          </Link>
        )}
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        <PageText text={instructions} year={year} />
        {max !== null && ` You can sign up for up to ${max} ${jobs(max)} yourself.`}
        {volunteerGuide && (
          <>
            {" "}
            See the{" "}
            <Link to="/guides/volunteer" className="underline">
              volunteer guide
            </Link>{" "}
            for more.
          </>
        )}
      </p>
      <Notice tone={mine.length ? "ok" : "info"}>
        {mine.length
          ? `Your ${jobs(mine.length)}: ${mine.map((r) => r.title).join(", ")}.`
          : "You don't have a job yet."}
      </Notice>

      <ul className="space-y-3">
        {open.map((r) => (
          <li key={r.id} className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="font-semibold">{r.title}</h2>
              <span className={`text-sm ${r.full ? "text-charcoal" : "font-medium"}`}>
                {`${r.names.length} of ${r.slots} filled`}
              </span>
            </div>
            {r.commitment && <p className="text-sm font-medium text-charcoal">{r.commitment}</p>}
            {r.description && <p className="text-sm">{r.description}</p>}
            {r.names.length > 0 && (
              <p className="text-sm text-charcoal">{`Signed up: ${r.names.join(", ")}`}</p>
            )}
            <Form method="post">
              <input type="hidden" name="roleId" value={r.id} />
              <input type="hidden" name="title" value={r.title} />
              {r.mine ? (
                <button type="submit" name="intent" value="leave" className={btn.secondary}>
                  Leave this job
                </button>
              ) : r.full ? (
                <span className="text-sm text-charcoal">Full</span>
              ) : atMax ? (
                <span className="text-sm text-charcoal">
                  {`You're at the limit of ${max} ${jobs(max ?? 0)}.`}
                </span>
              ) : (
                <button type="submit" name="intent" value="join" className={btn.primary}>
                  Sign up
                </button>
              )}
            </Form>
          </li>
        ))}
      </ul>

      {assigned.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">Filled by Leads</h2>
          <p className="text-sm text-charcoal">
            Leads fill these jobs. Ask one of them if you'd like one.
          </p>
          <ul className="space-y-2">
            {assigned.map((r) => (
              <li key={r.id} className="rounded-xl bg-white p-3 text-sm ring-1 ring-dust-light">
                <span className="font-semibold">{r.title}</span>
                {r.names.length > 0
                  ? `: ${r.names.join(", ")}`
                  : r.filled > 0
                    ? `: ${r.filled} of ${r.slots} filled`
                    : ": nobody yet"}
                {r.description && <p className="mt-1">{r.description}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
