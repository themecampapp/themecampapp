// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Form, Link, redirect, useSearchParams } from "react-router";
import { PersonLink } from "~/components/PersonLink";
import { btn, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import { seasonDates } from "~/lib/data/key-dates.server";
import {
  type RequestRow,
  requestBoard,
  saveTicketRequest,
  setRequestsLocked,
} from "~/lib/data/tickets.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.lead.tickets._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Stewards Sale") }];
}

// The list Leads send to Burning Man: who's buying through the camp's Stewards Sale access,
// how many tickets, whether they want a vehicle pass, and the email Burning Man will use.
// `show` narrows the page to one group (the roster's counts link here); `q` finds a camper by
// name or email. The copy-list buttons always use the whole "buying" group.
const SHOW = ["missing", "buying", "elsewhere"] as const;
type Show = (typeof SHOW)[number];

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = getDb(context);
  const url = new URL(request.url);
  const param = url.searchParams.get("show");
  const show = SHOW.includes(param as Show) ? (param as Show) : null;
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const board = await requestBoard(db);
  const match = (r: RequestRow) =>
    !q || [r.name, r.legalName, r.email ?? ""].some((v) => v.toLowerCase().includes(q));
  const closes = (await seasonDates(db)).find((d) => d.action === "tickets_close")?.date ?? null;
  return {
    ...board,
    allBuying: board.buying,
    buying: board.buying.filter(match),
    elsewhere: board.elsewhere.filter(match),
    noRequest: board.noRequest.filter(match),
    show,
    q,
    closes,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) => redirect(`/tickets?notice=${encodeURIComponent(msg)}`);
  try {
    switch (get("intent")) {
      case "lock":
        await setRequestsLocked(db, viewer, get("locked") === "true");
        return done(get("locked") === "true" ? "Requests locked." : "Requests unlocked.");
      case "record_request":
        await saveTicketRequest(
          db,
          viewer.personId,
          get("personId"),
          {
            ticketsNeeded: get("ticketsNeeded") === "elsewhere" ? 0 : Number(get("ticketsNeeded")),
            hasTicketElsewhere: get("ticketsNeeded") === "elsewhere",
            vehiclePassNeeded: form.get("vehiclePassNeeded") === "on",
            note: null,
          },
          { bypassLock: true },
        );
        return done("Request recorded.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={btn.secondary}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">
        {title} <span className="font-normal text-charcoal">({count})</span>
      </h2>
      {children}
    </section>
  );
}

const card = "rounded-xl bg-white p-3 ring-1 ring-dust-light";

export default function StewardsSale({ loaderData, actionData }: Route.ComponentProps) {
  const { allBuying, buying, elsewhere, noRequest, totals, locked, show, q, closes } = loaderData;
  const shown = (g: "missing" | "buying" | "elsewhere") => !show || show === g;
  const [params] = useSearchParams();
  // Tab-separated, so it pastes straight into a spreadsheet.
  const table = [
    ["Name", "Playa name", "Email", "Tickets", "Vehicle pass"].join("\t"),
    ...allBuying.map((r) =>
      [
        r.legalName,
        r.name === r.legalName ? "" : r.name,
        r.email ?? "",
        String(r.ticketsNeeded ?? 0),
        r.vehiclePassNeeded ? "Yes" : "No",
      ].join("\t"),
    ),
  ].join("\n");
  const emails = allBuying.map((r) => r.email).filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <PageHeader title="Stewards Sale">
        <Form method="post">
          <input type="hidden" name="intent" value="lock" />
          <input type="hidden" name="locked" value={String(!locked)} />
          <button type="submit" className={locked ? btn.primary : btn.secondary}>
            {locked ? "Unlock requests" : "Lock requests"}
          </button>
        </Form>
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        {`${allBuying.length} campers buying through the camp · ${totals.tickets} tickets · ${totals.vehiclePasses} vehicle passes · requests are ${locked ? "locked" : "open"}${closes ? ` (they close ${new Date(`${closes}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})` : ""}.`}{" "}
        Burning Man emails each camper at their Burner profile email to buy their own, so check the
        emails below match.
      </p>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        {show && <input type="hidden" name="show" value={show} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Find a camper"
          aria-label="Find a camper by name or email"
          className={`${input} w-56`}
        />
        <button type="submit" className={btn.secondary}>
          Find
        </button>
        {(show || q) && (
          <Link to="/tickets" className="text-sm underline">
            Show everyone
          </Link>
        )}
      </Form>

      {shown("missing") && (
        <Section title="Coming, no request yet" count={noRequest.length}>
          {noRequest.length === 0 ? (
            <p className="text-sm text-charcoal">Everyone coming has answered.</p>
          ) : (
            <ul className="space-y-2">
              {noRequest.map((r) => (
                <li key={r.personId} className={card}>
                  <Form method="post" className="flex flex-wrap items-center gap-2 text-sm">
                    <PersonLink id={r.personId} className="mr-auto font-medium">
                      {r.name}
                    </PersonLink>
                    <input type="hidden" name="intent" value="record_request" />
                    <input type="hidden" name="personId" value={r.personId} />
                    <select
                      name="ticketsNeeded"
                      defaultValue="1"
                      className={`${input} w-auto`}
                      aria-label={`Tickets for ${r.name}`}
                    >
                      {Array.from({ length: loaderData.maxTickets + 1 }, (_, i) => i).map((n) => (
                        <option key={n} value={String(n)}>
                          {n}
                        </option>
                      ))}
                      <option value="elsewhere">Has one elsewhere</option>
                    </select>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" name="vehiclePassNeeded" /> VP
                    </label>
                    <button type="submit" className={btn.secondary}>
                      Record for them
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {shown("buying") && (
        <Section title="Buying through the camp" count={buying.length}>
          {buying.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <CopyButton label="Copy list" text={table} />
              <CopyButton label={`Copy ${emails.length} emails`} text={emails.join(", ")} />
            </div>
          )}
          {buying.length === 0 ? (
            <p className="text-sm text-charcoal">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
              {buying.map((r) => (
                <li key={r.personId} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span>
                      <PersonLink
                        id={r.personId}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {r.name}
                      </PersonLink>
                      {r.name !== r.legalName && (
                        <span className="ml-2 text-sm text-charcoal">{r.legalName}</span>
                      )}
                    </span>
                    <span className="text-sm">
                      {`${r.ticketsNeeded ?? 0} ${r.ticketsNeeded === 1 ? "ticket" : "tickets"}${r.vehiclePassNeeded ? " + vehicle pass" : ""}`}
                    </span>
                  </div>
                  <div className="break-all text-sm text-charcoal">
                    {r.email ?? "no email: add one before sending the list"}
                  </div>
                  {r.note && <p className="text-sm text-charcoal">{`"${r.note}"`}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {shown("elsewhere") && (
        <Section title="Have a ticket elsewhere" count={elsewhere.length}>
          {elsewhere.length === 0 ? (
            <p className="text-sm text-charcoal">No one yet.</p>
          ) : (
            <p className="text-sm">{elsewhere.map((r) => r.name).join(", ")}</p>
          )}
        </Section>
      )}
    </div>
  );
}
