// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link, redirect } from "react-router";
import { RsvpForm } from "~/components/RsvpForm";
import { PageHeader } from "~/components/ui";
import { requireAccess } from "~/lib/access.server";
import { backLink } from "~/lib/back-link";
import { pageTitle, useCamp } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { pageTexts } from "~/lib/data/page-text.server";
import {
  currentYear,
  getRsvp,
  parseRsvpForm,
  personName,
  saveRsvp,
} from "~/lib/data/participation.server";
import { getSapDays, sapDayOptions } from "~/lib/data/sap.server";
import { fillPageText } from "~/lib/page-text";
import type { Route } from "./+types/_app.lead.people.$id.rsvp";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Edit RSVP") }];
}

// A Lead entering a camper's RSVP/logistics on their behalf (attributed to the Lead).
export async function loader({ params, context }: Route.LoaderArgs) {
  const db = getDb(context);
  const name = await personName(db, params.id);
  if (!name) throw data({ reason: "not_found" }, { status: 404 });
  return {
    name,
    year: await currentYear(db),
    sapHint: (await pageTexts(db, ["rsvp_sap_hint"])).rsvp_sap_hint,
    sapDays: sapDayOptions(await getSapDays(db)),
    showSap: (await getSettings(context)).features.saps,
    rsvp: await getRsvp(db, params.id),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const parsed = parseRsvpForm(await request.formData());
  if ("error" in parsed) return parsed;
  const db = getDb(context);
  if (!(await personName(db, params.id))) throw data({ reason: "not_found" }, { status: 404 });
  // RSVPing for someone is Roster & RSVPs: manage (issue #93; the middleware checks it too).
  const viewer = requireAccess(context, "roster", "manage");
  await saveRsvp(db, viewer.personId, params.id, parsed.input);
  const back = new URL(request.url).searchParams.get("back");
  const keep = back ? `&back=${encodeURIComponent(backLink(back).to)}` : "";
  return redirect(`/people/${params.id}?notice=${encodeURIComponent("RSVP saved.")}${keep}`);
}

export default function LeadRsvp({ loaderData, actionData, params }: Route.ComponentProps) {
  const { campName } = useCamp();
  return (
    <section className="max-w-2xl">
      <Link
        to={`/people/${params.id}`}
        className="inline-block text-sm underline pointer-coarse:py-2.5"
      >
        ← {loaderData.name}
      </Link>
      <PageHeader title={`${loaderData.year} RSVP for ${loaderData.name}`} />
      <p className="mb-4 text-sm text-charcoal">
        You're entering this on their behalf. They'll see it was updated by you.
      </p>
      <RsvpForm
        sapHint={fillPageText(loaderData.sapHint, { camp: campName, year: loaderData.year })}
        showSap={loaderData.showSap}
        year={loaderData.year}
        sapDays={loaderData.sapDays}
        values={loaderData.rsvp}
        error={actionData?.error}
        submitLabel="Save for them"
      />
    </section>
  );
}
