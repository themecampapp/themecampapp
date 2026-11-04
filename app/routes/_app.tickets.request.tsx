// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { GuideLink } from "~/components/GuideLink";
import { PageText } from "~/components/PageText";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { getMyTickets, parseRequestForm, saveTicketRequest } from "~/lib/data/tickets.server";
import { formError } from "~/lib/errors";
import { fillPageText } from "~/lib/page-text";
import type { Route } from "./+types/_app.tickets.request";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Stewards Sale tickets") }];
}

// A member's own Stewards Sale request. Always the signed-in person; no id in the URL.
export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  return {
    ...(await getMyTickets(db, getViewer(context).personId)),
    year: (await getSettings(context)).currentYear,
    texts: await pageTexts(db, ["tickets_intro", "tickets_count_hint", "tickets_locked"]),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const { maxTickets } = await getSettings(context);
  const parsed = parseRequestForm(await request.formData(), maxTickets);
  if ("error" in parsed) return parsed;
  try {
    await saveTicketRequest(db, viewer.personId, viewer.personId, parsed.input);
  } catch (e) {
    return formError(e);
  }
  return redirect("/?saved=tickets");
}

export default function TicketRequest({ loaderData, actionData }: Route.ComponentProps) {
  const { request: req, locked, canRequest, maxTickets, texts, year } = loaderData;
  const { campName } = useCamp();
  const [params] = useSearchParams();
  const fromRsvp = params.get("from") === "rsvp";

  return (
    <section className="max-w-lg space-y-4">
      <Link to="/" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← Home
      </Link>
      <PageHeader title="Stewards Sale tickets" />
      {fromRsvp && (
        <Notice tone="ok">RSVP saved! Next: do you need a ticket through the camp?</Notice>
      )}

      {!canRequest ? (
        <Notice>
          Ticket requests are for campers who are Going or Leaning yes.{" "}
          <Link to="/rsvp" className="font-semibold underline">
            Update your RSVP
          </Link>{" "}
          first.
        </Notice>
      ) : (
        <>
          <p className="text-sm text-charcoal">
            <PageText text={texts.tickets_intro} year={year} />{" "}
            <GuideLink slug="tickets-stewards-sale" className="font-semibold underline">
              How the Stewards Sale works
            </GuideLink>
          </p>

          {locked ? (
            <Notice>
              {req
                ? `${fillPageText(texts.tickets_locked, { camp: campName, year })} You asked for ${req.hasTicketElsewhere ? "no tickets (you have one already)" : `${req.ticketsNeeded} ticket(s)`}${req.vehiclePassNeeded ? " and a vehicle pass" : ""}. Ask a Lead if something changed.`
                : `${fillPageText(texts.tickets_locked, { camp: campName, year })} Ask a Lead if you still need a ticket.`}
            </Notice>
          ) : (
            <Form
              method="post"
              className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light"
            >
              {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
              <Field
                label="How many tickets do you need through the camp?"
                hint={fillPageText(texts.tickets_count_hint, { camp: campName, year }) || undefined}
              >
                <select
                  name="ticketsNeeded"
                  defaultValue={String(req?.ticketsNeeded ?? 1)}
                  className={input}
                >
                  <option value="0">None</option>
                  {Array.from({ length: maxTickets }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="hasTicketElsewhere"
                  defaultChecked={req?.hasTicketElsewhere ?? false}
                  className="mt-1"
                />
                <span>
                  I already have a ticket from somewhere else (main sale, transfer, work pass…)
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="vehiclePassNeeded"
                  defaultChecked={req?.vehiclePassNeeded ?? false}
                  className="mt-1"
                />
                <span>I need a vehicle pass</span>
              </label>
              <Field label="Anything Leads should know? (optional)">
                <textarea
                  name="note"
                  rows={2}
                  maxLength={500}
                  defaultValue={req?.note ?? ""}
                  className={input}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={btn.primary}>
                  {req ? "Update request" : "Send request"}
                </button>
                {fromRsvp && (
                  <Link to="/" className={btn.secondary}>
                    Skip for now
                  </Link>
                )}
              </div>
            </Form>
          )}
        </>
      )}
    </section>
  );
}
