// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, useFetcher, useRouteLoaderData, useSearchParams } from "react-router";
import { GuideLink } from "~/components/GuideLink";
import { LinkedText } from "~/components/LinkedText";
import { PageText } from "~/components/PageText";
import { btn, INTENT_LABEL, Notice } from "~/components/ui";
import { can, getViewer, inWorkspace } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { currentAnnouncements } from "~/lib/data/announcements.server";
import { setupChecklist, showsChecklist } from "~/lib/data/checklist.server";
import { directoryChoice } from "~/lib/data/directory.server";
import { formatCents, myDues } from "~/lib/data/dues.server";
import { lockReminder, upcomingDates } from "~/lib/data/key-dates.server";
import { campOverview } from "~/lib/data/overview.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { currentYear, getRsvp } from "~/lib/data/participation.server";
import { formatSapDay, mySap } from "~/lib/data/sap.server";
import { getMyTickets } from "~/lib/data/tickets.server";
import { rolesFor } from "~/lib/data/volunteer.server";
import type { FeatureKey } from "~/lib/features";
import { ACTION_LABEL } from "~/lib/key-dates";
import type { AreaKey } from "~/lib/permissions";
import type { loader as appLoader } from "./_app";
import type { Route } from "./+types/_app._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Home") }];
}

// The main page of each area of the camp's tools, for the "Your tools" card.
const TOOLS: Array<[AreaKey, string, string, FeatureKey?]> = [
  ["roster", "/roster", "Roster"],
  ["tickets", "/tickets", "Tickets"],
  ["dues", "/dues", "Dues", "dues"],
  ["saps", "/saps", "SAPs", "saps"],
  ["volunteer", "/volunteers", "Jobs", "volunteer"],
  ["inquiries", "/inquiries", "Inquiries", "join"],
  ["announcements", "/announcements", "Announcements"],
  ["announcements", "/dates", "Key dates"],
  ["guides", "/guide-editor", "Guides"],
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const v = getViewer(context);
  const db = getDb(context);
  const rsvp = await getRsvp(db, v.personId);
  const mine = await getMyTickets(db, v.personId);
  const dues = await myDues(db, v.personId);
  const sap = await mySap(db, v.personId);
  const volunteering = (await rolesFor(db, [v.personId])).get(v.personId) ?? [];
  // The camp's own volunteer instructions (issue #29), shown until they have a job.
  const texts = await pageTexts(db, ["volunteer_instructions", "dues_timing", "yearbook_card"]);
  const volunteerText = volunteering.length ? "" : texts.volunteer_instructions;
  const directory = await directoryChoice(db, v.personId);
  const settings = await getSettings(context);
  const { features } = settings;
  // R72 block 5, R24: the setup checklist, until it's done or dismissed.
  // The instance's support community (SUPPORT_URL, open-source plan 2.4), or none.
  const { env } = context.get(cloudflareContext);
  const supportUrl = env.SUPPORT_URL || null;
  const checklist = showsChecklist(v, settings)
    ? await setupChecklist(db, settings, { product: env.PRODUCT_NAME, supportUrl })
    : null;
  const lockDate = can(v, "tickets") ? await lockReminder(db) : null;
  // Leads and Admins choose between the camp's Overview (the default) and their own
  // participation (Lead workspace plan, Unit 7). Members have no switch.
  const view = inWorkspace(v)
    ? new URL(request.url).searchParams.get("view") === "mine"
      ? ("mine" as const)
      : ("overview" as const)
    : null;
  const overview = view === "overview" ? await campOverview(db, v, features) : [];

  // R72 block 2: what this member still has to do this season.
  const todos: Array<{ label: string; to: string }> = [];
  if (!rsvp?.intent) todos.push({ label: "RSVP for this year", to: "/rsvp" });
  if (mine.canRequest && !mine.request && !mine.locked) {
    todos.push({
      label: "Request Stewards Sale tickets, or say you have one",
      to: "/tickets/request",
    });
  }
  if (features.dues && dues && dues.status === "unpaid" && dues.owedCents !== null) {
    todos.push({ label: `Pay your dues (${formatCents(dues.owedCents)})`, to: "#dues" });
  }
  const roles = v.roles.includes("admin")
    ? ["Admin"]
    : [v.roles.includes("lead") && "Lead", v.roles.includes("treasurer") && "Treasurer"].filter(
        (r): r is string => !!r,
      );
  // Issue #93: someone whose roles give them some of the camp's tools but not People (so not
  // the Lead home) gets a card with a way into each one.
  const tools = inWorkspace(v)
    ? []
    : TOOLS.filter(([area, , , feature]) => can(v, area) && (!feature || features[feature])).map(
        ([, to, label]) => ({ to, label }),
      );
  return {
    features,
    tools,
    todos,
    lockDate,
    view,
    overview,
    checklist: checklist?.some((i) => !i.done) ? checklist : null,
    announcements: (await currentAnnouncements(db)).map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      postedOn: a.createdAt.toISOString(),
    })),
    dates: (await upcomingDates(db, features)).map((d) => ({
      id: d.id,
      label: d.label,
      date: d.date,
      action: d.action,
    })),
    isAdmin: v.isAdmin === true,
    supportUrl,
    year: await currentYear(db),
    name: v.playaName ?? v.legalName,
    roles,
    // Posting announcements and key dates from the home page (issue #93: by area).
    canPost: can(v, "announcements", "manage"),
    tickets: mine.canRequest
      ? {
          request: mine.request,
          locked: mine.locked,
        }
      : null,
    askDirectory: !directory.chosen,
    volunteering,
    volunteerText,
    duesTiming: texts.dues_timing,
    yearbookCard: texts.yearbook_card,
    season: settings.currentYear,
    sap: features.saps &&
      sap && {
        status: sap.status,
        requestedDay: sap.requestedDate ? formatSapDay(sap.requestedDate) : null,
        approvedDay: sap.approvedDate ? formatSapDay(sap.approvedDate) : null,
        downloadUrl: sap.downloadId ? `/saps/pass/${sap.downloadId}/pdf` : null,
      },
    dues: features.dues &&
      dues && {
        year: dues.year,
        status: dues.status,
        amount: dues.owedCents === null ? null : formatCents(dues.owedCents),
        tier: dues.tierName,
        paidAmount: dues.paidAmountCents === null ? null : formatCents(dues.paidAmountCents),
        paidOn: dues.paidOn,
        instructions: dues.instructions,
      },
    rsvp: rsvp && {
      intent: rsvp.intent,
      arrivalDate: rsvp.arrivalDate,
      departureDate: rsvp.departureDate,
      updatedByOther: rsvp.updatedByOther,
      updatedAt: rsvp.updatedAt,
    },
  };
}

function Card({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </div>
  );
}

const fmt = (d: string | null) =>
  d
    ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

export default function Home({ loaderData }: Route.ComponentProps) {
  const { rsvp } = loaderData;
  const { productName } = useCamp();
  const [params] = useSearchParams();
  const orientation = useRouteLoaderData<typeof appLoader>("routes/_app")?.orientation;
  // Issue #82: notes that the checklist's Discord link was opened, while it opens in a new tab.
  const community = useFetcher();
  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{`Welcome, ${loaderData.name}`}</h1>
        {loaderData.roles.length > 0 && (
          <p className="text-sm text-charcoal">{`You're ${/^[AEIOU]/.test(loaderData.roles[0]) ? "an" : "a"} ${loaderData.roles.join(" and ")}.`}</p>
        )}
      </div>
      {params.get("saved") === "rsvp" && <Notice tone="ok">Your RSVP is saved. Thanks!</Notice>}
      {params.get("saved") === "directory" && (
        <Notice tone="ok">Saved. You can change it any time on your profile.</Notice>
      )}
      {loaderData.askDirectory && (
        <Form
          method="post"
          action="/profile"
          className="space-y-3 rounded-xl bg-gold-glow p-4 ring-1 ring-gold"
        >
          <h2 className="font-semibold">Share your contact details with campers?</h2>
          <p className="text-sm">
            The camp directory lists everyone coming this year so people can reach each other. Your
            Yearbook name is always shown. Sharing adds your full name, email and phone. Until you
            choose, they stay hidden.
          </p>
          <input type="hidden" name="intent" value="directory" />
          <input type="hidden" name="next" value="/" />
          <div className="flex flex-wrap gap-2">
            <button type="submit" name="share" value="yes" className={btn.primary}>
              Share them
            </button>
            <button type="submit" name="share" value="no" className={btn.secondary}>
              Keep them hidden
            </button>
          </div>
        </Form>
      )}
      {params.get("saved") === "tickets" && (
        <Notice tone="ok">Your ticket request is saved.</Notice>
      )}
      {loaderData.view && (
        <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Home view">
          <div data-tour="home-view" className="flex gap-2">
            <Link
              to="/?view=overview"
              aria-current={loaderData.view === "overview" ? "page" : undefined}
              className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${loaderData.view === "overview" ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
            >
              Overview
            </Link>
            <Link
              to="/?view=mine"
              aria-current={loaderData.view === "mine" ? "page" : undefined}
              className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${loaderData.view === "mine" ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
            >
              My participation
              {loaderData.todos.length > 0 && (
                <span className="ml-1.5 rounded-full bg-coral px-1.5 text-xs text-white">
                  {loaderData.todos.length}
                  <span className="sr-only"> to do</span>
                </span>
              )}
            </Link>
          </div>
          {/* Issue #65: (re)start the Lead orientation. */}
          {orientation && (
            <Link
              to={`/?${new URLSearchParams({ ...(loaderData.view === "mine" ? { view: "mine" } : {}), tour: "start" })}`}
              data-tour="tour-link"
              className="ml-auto text-charcoal underline pointer-coarse:py-2.5"
            >
              Take the tour
            </Link>
          )}
        </nav>
      )}

      {loaderData.view === "overview" ? (
        <>
          <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
            <h2 className="font-semibold">Camp to-dos</h2>
            {loaderData.overview.length === 0 ? (
              <p className="text-sm">Nothing needs doing right now.</p>
            ) : (
              <ul className="space-y-1">
                {loaderData.overview.map((o) => (
                  <li key={o.key}>
                    <Link to={o.to} className="font-semibold underline">
                      {o.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {loaderData.lockDate && (
            <Notice>
              {`Ticket requests were due to close on ${fmt(loaderData.lockDate)}, and they're still open. `}
              <Link to="/tickets" className="font-semibold underline">
                Lock them on the Stewards Sale page
              </Link>{" "}
              when you're ready to send the list.
            </Notice>
          )}
          {loaderData.checklist && (
            // R72 block 5, R24: only Admins and Leads, in a camp created in the console.
            <div
              data-tour="checklist"
              className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-gold"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">Setting up your camp</h2>
                <span className="text-sm text-charcoal">
                  {`${loaderData.checklist.filter((i) => i.done).length} of ${loaderData.checklist.length} done`}
                </span>
              </div>
              <ul className="space-y-1.5 text-sm">
                {loaderData.checklist.map((i) => (
                  <li key={i.key} className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className={i.done ? "text-green-700" : "text-charcoal"}
                    >
                      {i.done ? "✓" : "○"}
                    </span>
                    {i.done ? (
                      <span className="text-charcoal line-through">
                        {i.label}
                        <span className="sr-only"> (done)</span>
                      </span>
                    ) : i.external ? (
                      <a
                        href={i.to}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() =>
                          community.submit(
                            { intent: "community" },
                            { method: "post", action: "/setup-checklist" },
                          )
                        }
                        className="font-semibold underline"
                      >
                        {i.label}
                      </a>
                    ) : (
                      <Link to={i.to} className="font-semibold underline">
                        {i.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              <Form method="post" action="/setup-checklist">
                <input type="hidden" name="intent" value="dismiss" />
                <button type="submit" className="text-sm text-charcoal underline">
                  Hide this checklist
                </button>
              </Form>
              {loaderData.isAdmin && (
                <p className="text-xs text-charcoal">You can bring it back from the Admin page.</p>
              )}
            </div>
          )}
          {(loaderData.announcements.length > 0 || loaderData.canPost) && (
            <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">Announcements</h2>
                {loaderData.canPost && (
                  <Link to="/announcements" className="text-sm underline">
                    {loaderData.announcements.length ? "Manage" : "Post one"}
                  </Link>
                )}
              </div>
              {loaderData.announcements.length === 0 ? (
                <p className="text-sm text-charcoal">No announcements right now.</p>
              ) : (
                <ul className="space-y-3">
                  {loaderData.announcements.map((a) => (
                    <li key={a.id}>
                      <p className="font-semibold">{a.title}</p>
                      {a.body && (
                        <p className="text-sm">
                          <LinkedText text={a.body} />
                        </p>
                      )}
                      <p className="text-xs text-charcoal">
                        {`Posted ${new Date(a.postedOn).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {(loaderData.dates.length > 0 || loaderData.canPost) && (
            <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">Coming up</h2>
                {loaderData.canPost && (
                  <Link to="/dates" className="text-sm underline">
                    {loaderData.dates.length ? "Manage" : "Add dates"}
                  </Link>
                )}
              </div>
              {loaderData.dates.length === 0 ? (
                <p className="text-sm text-charcoal">No upcoming dates yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {loaderData.dates.map((d) => (
                    <li key={d.id}>
                      <span className="font-semibold">{fmt(d.date)}</span>
                      {` · ${d.label}`}
                      {d.action && (
                        <span className="text-charcoal">{` (${ACTION_LABEL[d.action]})`}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {loaderData.isAdmin && loaderData.supportUrl && (
            // Issue #82: always on the Overview, for Admins (when the instance has a community).
            <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <h2 className="font-semibold">{`${productName} admin community`}</h2>
              <p className="text-sm">
                {`The ${productName} Discord server is the way to talk with the app's developer, and the best way to get support or ask for new features.`}
              </p>
              <a
                href={loaderData.supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${btn.secondary} text-sm`}
              >
                Join the Discord server
              </a>
            </div>
          )}
        </>
      ) : (
        <>
          {loaderData.tools.length > 0 && (
            <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <h2 className="font-semibold">Your tools</h2>
              <ul className="flex flex-wrap gap-2">
                {loaderData.tools.map((t) => (
                  <li key={t.to}>
                    <Link to={t.to} className={btn.secondary}>
                      {t.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-dust-light">
            <h2 className="font-semibold">Your to-dos</h2>
            {loaderData.todos.length === 0 ? (
              <p className="text-sm">You're all set. Thanks!</p>
            ) : (
              <ul className="space-y-1">
                {loaderData.todos.map((t) => (
                  <li key={t.to}>
                    <Link to={t.to} className="font-semibold underline">
                      {t.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(loaderData.announcements.length > 0 || loaderData.canPost) && (
            <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">Announcements</h2>
                {loaderData.canPost && (
                  <Link to="/announcements" className="text-sm underline">
                    {loaderData.announcements.length ? "Manage" : "Post one"}
                  </Link>
                )}
              </div>
              {loaderData.announcements.length === 0 ? (
                <p className="text-sm text-charcoal">No announcements right now.</p>
              ) : (
                <ul className="space-y-3">
                  {loaderData.announcements.map((a) => (
                    <li key={a.id}>
                      <p className="font-semibold">{a.title}</p>
                      {a.body && (
                        <p className="text-sm">
                          <LinkedText text={a.body} />
                        </p>
                      )}
                      <p className="text-xs text-charcoal">
                        {`Posted ${new Date(a.postedOn).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {(loaderData.dates.length > 0 || loaderData.canPost) && (
            <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-semibold">Coming up</h2>
                {loaderData.canPost && (
                  <Link to="/dates" className="text-sm underline">
                    {loaderData.dates.length ? "Manage" : "Add dates"}
                  </Link>
                )}
              </div>
              {loaderData.dates.length === 0 ? (
                <p className="text-sm text-charcoal">No upcoming dates yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {loaderData.dates.map((d) => (
                    <li key={d.id}>
                      <span className="font-semibold">{fmt(d.date)}</span>
                      {` · ${d.label}`}
                      {d.action && (
                        <span className="text-charcoal">{` (${ACTION_LABEL[d.action]})`}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title={`${loaderData.year} RSVP`}>
              {rsvp?.intent ? (
                <>
                  <p className="text-lg font-semibold">{INTENT_LABEL[rsvp.intent]}</p>
                  {(rsvp.arrivalDate || rsvp.departureDate) && (
                    <p className="text-sm text-charcoal">
                      {[fmt(rsvp.arrivalDate) ?? "?", fmt(rsvp.departureDate) ?? "?"].join(" → ")}
                    </p>
                  )}
                  {rsvp.updatedByOther && (
                    <p className="text-sm text-charcoal">
                      {`Updated by ${rsvp.updatedByOther} on ${new Date(rsvp.updatedAt).toLocaleDateString()}`}
                    </p>
                  )}
                  <Link to="/rsvp" className={btn.secondary}>
                    Update RSVP
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-charcoal">{`Let us know if you're coming in ${loaderData.year}.`}</p>
                  <Link to="/rsvp" className={btn.primary}>
                    {`RSVP for ${loaderData.year}`}
                  </Link>
                </>
              )}
            </Card>

            {loaderData.tickets && (
              <Card title="Stewards Sale">
                {loaderData.tickets.request ? (
                  <>
                    <p className="text-sm">
                      {loaderData.tickets.request.hasTicketElsewhere
                        ? "You have a ticket from elsewhere."
                        : `Requested: ${loaderData.tickets.request.ticketsNeeded} ticket(s)${loaderData.tickets.request.vehiclePassNeeded ? " + vehicle pass" : ""}`}
                    </p>
                    {!loaderData.tickets.request.hasTicketElsewhere && (
                      <p className="text-sm text-charcoal">
                        Burning Man will email you at your Burner profile address with how to buy.
                      </p>
                    )}
                    <Link to="/tickets/request" className={btn.secondary}>
                      {loaderData.tickets.locked ? "View request" : "Update request"}
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-charcoal">
                      Need a ticket through the camp's Stewards Sale access?
                    </p>
                    <Link to="/tickets/request" className={btn.primary}>
                      Request tickets
                    </Link>
                  </>
                )}
              </Card>
            )}

            {loaderData.dues && (
              <Card title={`${loaderData.dues.year} dues`} id="dues">
                {loaderData.dues.status === "paid" ? (
                  <p className="text-sm">
                    <span className="font-semibold">Paid</span>
                    {` ${loaderData.dues.paidAmount ?? ""} on ${fmt(loaderData.dues.paidOn) ?? "?"}. Thank you!`}
                  </p>
                ) : loaderData.dues.status === "waived" ? (
                  <p className="text-sm">
                    <span className="font-semibold">Waived</span> for this year.
                  </p>
                ) : loaderData.dues.amount === null ? (
                  <p className="text-sm text-charcoal">
                    Dues for this year aren't set yet. We'll let you know.
                  </p>
                ) : (
                  <>
                    <p className="text-sm">
                      <span className="font-semibold">{`${loaderData.dues.amount} due`}</span>
                      {loaderData.dues.tier && (
                        <span className="text-charcoal">{` (${loaderData.dues.tier})`}</span>
                      )}
                      <span className="text-charcoal"> · not recorded as paid yet</span>
                    </p>
                    {loaderData.dues.instructions && (
                      <p className="whitespace-pre-line text-sm text-charcoal">
                        {loaderData.dues.instructions}
                      </p>
                    )}
                    {loaderData.duesTiming && (
                      <p className="text-xs text-charcoal">
                        <PageText text={loaderData.duesTiming} year={loaderData.season} />
                      </p>
                    )}
                  </>
                )}
                <GuideLink slug="dues" className="text-sm underline">
                  About dues
                </GuideLink>
              </Card>
            )}

            {loaderData.sap && (
              <Card title="Setup Access Pass">
                {loaderData.sap.status === "approved" ? (
                  <>
                    <p className="text-sm">
                      <span className="font-semibold">Approved</span>
                      {loaderData.sap.approvedDay && ` for ${loaderData.sap.approvedDay}`}.
                    </p>
                    {loaderData.sap.downloadUrl ? (
                      <>
                        <a href={loaderData.sap.downloadUrl} className={btn.primary}>
                          Download your pass
                        </a>
                        <p className="text-xs text-charcoal">
                          Print it: you need the paper pass at the gate to come in early.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-charcoal">
                        We'll email you when your pass is ready to download.
                      </p>
                    )}
                  </>
                ) : loaderData.sap.status === "denied" ? (
                  <p className="text-sm">
                    <span className="font-semibold">Not approved</span> this year. Talk to a camp
                    lead if you have questions.
                  </p>
                ) : (
                  <p className="text-sm text-charcoal">
                    {`Requested${loaderData.sap.requestedDay ? ` for ${loaderData.sap.requestedDay}` : ""}. A camp lead will review it.`}
                  </p>
                )}
                <GuideLink slug="sap" className="text-sm underline">
                  About SAPs
                </GuideLink>
              </Card>
            )}

            {loaderData.features.volunteer && (
              <Card title="Volunteer">
                {loaderData.volunteering.length ? (
                  <p className="text-sm">{`Your ${loaderData.volunteering.length === 1 ? "job" : "jobs"}: ${loaderData.volunteering.join(", ")}. Thank you!`}</p>
                ) : (
                  <p className="text-sm text-charcoal">
                    <PageText text={loaderData.volunteerText} year={loaderData.season} />
                  </p>
                )}
                <Link
                  to="/volunteer"
                  className={loaderData.volunteering.length ? btn.secondary : btn.primary}
                >
                  {loaderData.volunteering.length ? "See jobs" : "Choose a job"}
                </Link>
              </Card>
            )}

            {loaderData.features.yearbook && (
              <Card title="Yearbook">
                <p className="text-sm text-charcoal">
                  <PageText text={loaderData.yearbookCard} year={loaderData.season} />
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link to="/yearbook" className={btn.secondary}>
                    Open Yearbook
                  </Link>
                  <Link to="/profile" className="self-center text-sm underline">
                    Add your photo
                  </Link>
                </div>
              </Card>
            )}

            <Card title="Your profile">
              <p className="text-sm text-charcoal">
                Keep your name, playa name and phone up to date.
              </p>
              <Link to="/profile" className={btn.secondary}>
                Edit profile
              </Link>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
