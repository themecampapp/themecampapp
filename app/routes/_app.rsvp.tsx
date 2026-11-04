// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link, redirect } from "react-router";
import { useHasGuide } from "~/components/GuideLink";
import { PageText } from "~/components/PageText";
import { RsvpForm } from "~/components/RsvpForm";
import { Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { currentYear, getRsvp, parseRsvpForm, saveRsvp } from "~/lib/data/participation.server";
import { getSapDays, sapDayOptions } from "~/lib/data/sap.server";
import { getMyTickets } from "~/lib/data/tickets.server";
import { fillPageText } from "~/lib/page-text";
import type { Route } from "./+types/_app.rsvp";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "RSVP") }];
}

// A member's own RSVP. There's no person id in the URL: it always edits the signed-in person.
export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  return {
    year: await currentYear(db),
    sapDays: sapDayOptions(await getSapDays(db)),
    showSap: (await getSettings(context)).features.saps,
    rsvp: await getRsvp(db, getViewer(context).personId),
    texts: await pageTexts(db, ["rsvp_intro", "rsvp_sap_hint"]),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const parsed = parseRsvpForm(await request.formData());
  if ("error" in parsed) return parsed;
  const db = getDb(context);
  await saveRsvp(db, viewer.personId, viewer.personId, parsed.input);
  // Coming? Offer the ticket request next (skippable), unless they've already made one.
  if (parsed.input.intent === "going" || parsed.input.intent === "leaning_yes") {
    const mine = await getMyTickets(db, viewer.personId);
    if (!mine.request && !mine.locked) return redirect("/tickets/request?from=rsvp");
  }
  return redirect("/?saved=rsvp");
}

export default function Rsvp({ loaderData, actionData }: Route.ComponentProps) {
  const arrivalGuide = useHasGuide("arrival-build-strike");
  const { rsvp } = loaderData;
  const { campName } = useCamp();
  return (
    <section className="max-w-2xl">
      <Link to="/" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Home
      </Link>
      <PageHeader title={`Your ${loaderData.year} RSVP`} />
      {loaderData.texts.rsvp_intro && (
        <p className="mb-4 text-sm">
          <PageText text={loaderData.texts.rsvp_intro} year={loaderData.year} />
        </p>
      )}
      {arrivalGuide && (
        <p className="mb-4 text-sm text-charcoal">
          Questions about early arrival, passes or dwellings? See{" "}
          <Link to="/guides/arrival-build-strike" className="font-semibold underline">
            Arrival, build &amp; strike
          </Link>
          .
        </p>
      )}
      {rsvp?.updatedByOther && (
        <div className="mb-4">
          <Notice>
            {`Updated by ${rsvp.updatedByOther} on ${new Date(rsvp.updatedAt).toLocaleDateString()}. Change anything that's not right.`}
          </Notice>
        </div>
      )}
      <RsvpForm
        sapHint={fillPageText(loaderData.texts.rsvp_sap_hint, {
          camp: campName,
          year: loaderData.year,
        })}
        showSap={loaderData.showSap}
        year={loaderData.year}
        sapDays={loaderData.sapDays}
        values={rsvp}
        error={actionData?.error}
      />
    </section>
  );
}
