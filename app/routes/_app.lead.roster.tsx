// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Form, Link, Outlet, redirect, useLocation, useNavigation, useParams } from "react-router";
import { btn, input, Notice, PageHeader } from "~/components/ui";
import { can, getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { NUDGE_COOLDOWN_DAYS, nudgeCandidates, sendRsvpNudges } from "~/lib/data/nudge.server";
import { currentYear } from "~/lib/data/participation.server";
import {
  applyFilters,
  type SeasonRow,
  seasonCounts,
  seasonRows,
} from "~/lib/data/season-roster.server";
import { needsTicketCount } from "~/lib/data/tickets.server";
import { heldNotice } from "~/lib/mail.server";
import { cell, DUES_LABEL, day, SAP_LABEL, SORT_LABEL, TICKET_LABEL } from "~/lib/roster-cells";
import {
  COLUMN_LABEL,
  COLUMNS,
  type Column,
  DUES,
  formatDay,
  PRESETS,
  RSVP,
  RSVP_LABEL,
  readRosterQuery,
  SAP,
  SORTS,
  TICKET,
  upgradeOldView,
  VOLUNTEER,
} from "~/lib/roster-filters";
import type { Route } from "./+types/_app.lead.roster";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Roster") }];
}

// The season roster (Lead workspace plan, Unit 5): everyone in this season's camp, searchable,
// filterable and sortable, with the view in the URL. Opening a row shows that person beside
// the list (the nested route, Unit 6). Dues are for the Treasurer only: for anyone else they're
// never read, so no filter, sort or column can reveal them.
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const { features } = await getSettings(context);
  const treasurer = can(viewer, "dues") && features.dues;
  const url = new URL(request.url);
  // The roster's old ?view= links (bookmarks, older pages) go to the same view's new address.
  const upgraded = upgradeOldView(url.searchParams);
  if (upgraded) throw redirect(upgraded);
  const { preset, filters, columns } = readRosterQuery(url.searchParams, treasurer);
  const all = await seasonRows(db, { dues: treasurer, contact: can(viewer, "private") });
  const rows = applyFilters(all, filters);
  // On the No RSVP view: when each person was last nudged, and how many can be nudged now.
  const nudges =
    preset === "no-rsvp"
      ? Object.fromEntries((await nudgeCandidates(db)).map((c) => [c.personId, c]))
      : {};
  const shown = columns.filter(
    (c) =>
      (c !== "sap" || features.saps) &&
      (c !== "volunteer" || features.volunteer) &&
      (c !== "dues" || treasurer),
  );
  return {
    year: await currentYear(db),
    preset,
    filters,
    columns: shown,
    features: { saps: features.saps, volunteer: features.volunteer, dues: treasurer },
    counts: seasonCounts(all, treasurer),
    tickets: await needsTicketCount(db),
    rows: rows.map((r) => ({ ...r, lastNudgedAt: nudges[r.id]?.lastNudgedAt ?? null })),
    nudgeable: Object.values(nudges).filter((c) => c.canNudge).length,
    cooldownDays: NUDGE_COOLDOWN_DAYS,
  };
}

// "Send RSVP nudge email" to everyone on the No RSVP list who hasn't been nudged recently.
// The list is worked out again here, never taken from the form.
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") !== "nudge_all") return { error: "Unknown action." };
  const db = getDb(context);
  const ids = (await nudgeCandidates(db)).map((c) => c.personId);
  const { env } = context.get(cloudflareContext);
  const r = await sendRsvpNudges(db, env, getViewer(context), ids);
  const parts = [`Sent ${r.sent} RSVP ${r.sent === 1 ? "nudge" : "nudges"}.`];
  if (r.skipped)
    parts.push(`${r.skipped} skipped (nudged in the last ${NUDGE_COOLDOWN_DAYS} days).`);
  if (r.failed) parts.push(`${r.failed} failed to send; see the Queue.`);
  const held = heldNotice(r.held);
  if (held) parts.push(held);
  return redirect(`/roster?preset=no-rsvp&notice=${encodeURIComponent(parts.join(" "))}`);
}

type Row = SeasonRow & { lastNudgedAt: string | null };

function Stat({ label, value, to }: { label: string; value: number; to: string }) {
  return (
    <Link to={to} className="rounded-xl bg-white p-3 ring-1 ring-dust-light hover:ring-night">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm text-charcoal">{label}</div>
    </Link>
  );
}

function CopyEmails({ emails }: { emails: string[] }) {
  const [copied, setCopied] = useState(false);
  if (!emails.length) return null;
  return (
    <button
      type="button"
      className={btn.secondary}
      onClick={async () => {
        await navigator.clipboard.writeText(emails.join(", "));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied!" : `Copy ${emails.length} emails`}
    </button>
  );
}

// A filter chip: a select that's only as wide as its words, dark while its filter is on.
const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm pointer-coarse:py-2 ${on ? "border-night bg-night text-warm-white" : "border-dust bg-white text-night"}`;

function Chip({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: string | null;
  children: React.ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      aria-label={label}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
      className={chip(!!value)}
    >
      <option value="">{`${label}: any`}</option>
      {children}
    </select>
  );
}

export default function Roster({ loaderData, actionData }: Route.ComponentProps) {
  const { counts, rows, preset, filters, columns, features, nudgeable, cooldownDays } = loaderData;
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const { personId } = useParams();
  const sending = useNavigation().state === "submitting";
  // Ticked people (Unit 8). Nothing ticked means the actions apply to the whole view.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const chosen = picked.size ? rows.filter((r) => picked.has(r.id)) : rows;
  const emails = [...new Set(chosen.map((r) => r.email).filter(Boolean) as string[])];
  const filtered =
    !!params.get("q") ||
    ["rsvp", "ticket", "sap", "volunteer", "dues", "sort"].some((k) => params.get(k));
  // Opening a person keeps this exact view (preset, filters, sort, columns) in the URL.
  const open = (id: string) => `/roster/${id}${search}`;
  const groups =
    filters.groupBy === "arrival"
      ? [...new Set(rows.map((r) => r.arrivalDate ?? ""))].map((d) => ({
          label: d ? formatDay(d) : "Arrival unknown",
          rows: rows.filter((r) => (r.arrivalDate ?? "") === d),
        }))
      : [{ label: null, rows }];
  const presets = PRESETS.filter(
    (p) =>
      ("treasurer" in p ? features.dues : true) &&
      (p.key === "pending-sap" || p.key === "sap" ? features.saps : true) &&
      (p.key !== "no-volunteer" || features.volunteer),
  );
  const choosable = COLUMNS.filter(
    (c) =>
      (c !== "sap" || features.saps) &&
      (c !== "volunteer" || features.volunteer) &&
      (c !== "dues" || features.dues),
  );

  return (
    <section>
      <PageHeader title={`${loaderData.year} roster`}>
        <CopyEmails emails={emails} />
        {preset === "no-rsvp" && (
          <Form
            method="post"
            onSubmit={(e) => {
              if (
                !confirm(
                  `Email an RSVP reminder to ${nudgeable} ${nudgeable === 1 ? "person" : "people"}?`,
                )
              )
                e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="nudge_all" />
            <button type="submit" className={btn.primary} disabled={!nudgeable || sending}>
              {sending ? "Sending…" : `Send RSVP nudge email (${nudgeable})`}
            </button>
          </Form>
        )}
      </PageHeader>
      {params.get("notice") && (
        <div className="mb-4">
          <Notice tone="ok">{params.get("notice")}</Notice>
        </div>
      )}
      {actionData?.error && (
        <div className="mb-4">
          <Notice tone="error">{actionData.error}</Notice>
        </div>
      )}
      {preset === "no-rsvp" && (
        <p className="mb-4 text-sm text-charcoal">
          {`The nudge email asks each person to sign in and RSVP. Anyone nudged in the last ${cooldownDays} days is skipped.`}
        </p>
      )}

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Going" value={counts.going} to="/roster?rsvp=going" />
        <Stat label="Leaning yes" value={counts.leaningYes} to="/roster?rsvp=leaning_yes" />
        <Stat label="Leaning no" value={counts.leaningNo} to="/roster?rsvp=leaning_no" />
        <Stat label="Not going" value={counts.notGoing} to="/roster?rsvp=not_going" />
        <Stat label="No RSVP yet" value={counts.noRsvp} to="/roster?preset=no-rsvp" />
        <Stat
          label="Need a ticket"
          value={loaderData.tickets.needsTicket}
          to="/tickets?show=buying"
        />
        <Stat
          label="No ticket request"
          value={counts.missingTicket}
          to="/roster?preset=missing-ticket"
        />
        {features.saps && (
          <Stat label="SAP to decide" value={counts.pendingSap} to="/roster?preset=pending-sap" />
        )}
        {features.volunteer && (
          <Stat label="No job" value={counts.noVolunteer} to="/roster?preset=no-volunteer" />
        )}
        {counts.unpaid !== null && (
          <Stat label="Dues unpaid" value={counts.unpaid} to="/roster?preset=unpaid" />
        )}
      </div>

      <nav className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="Roster views">
        {presets.map((p) => {
          const current = preset === p.key && !filtered;
          return (
            <Link
              key={p.key}
              to={`/roster?preset=${p.key}`}
              aria-current={current ? "page" : undefined}
              className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${current ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
            >
              {p.label}
            </Link>
          );
        })}
      </nav>

      <Form method="get" className="mb-4 space-y-2">
        <input type="hidden" name="preset" value={preset} />
        <div className="flex max-w-md gap-2">
          <input
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Find by name, playa name or email"
            aria-label="Search the roster"
            className={`${input} py-1.5 text-sm`}
          />
          <button type="submit" className={`${btn.secondary} py-1.5 text-sm`}>
            Search
          </button>
        </div>
        {/* Each filter is a chip that's only as wide as its words, dark while it's on, and
            applies as soon as it changes (the Search button applies them without JavaScript). */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Chip name="rsvp" label="RSVP" value={params.get("rsvp")}>
            {RSVP.map((v) => (
              <option key={v} value={v}>
                {`RSVP: ${RSVP_LABEL[v]}`}
              </option>
            ))}
          </Chip>
          <Chip name="ticket" label="Ticket" value={params.get("ticket")}>
            {TICKET.map((v) => (
              <option key={v} value={v}>
                {`Ticket: ${TICKET_LABEL[v].toLowerCase()}`}
              </option>
            ))}
          </Chip>
          {features.saps && (
            <Chip name="sap" label="SAP" value={params.get("sap")}>
              {SAP.map((v) => (
                <option key={v} value={v}>
                  {`SAP: ${SAP_LABEL[v].replace(/^SAP /, "").replace(/^Asked for a SAP$/, "asked for one")}`}
                </option>
              ))}
            </Chip>
          )}
          {features.volunteer && (
            <Chip name="volunteer" label="Jobs" value={params.get("volunteer")}>
              {VOLUNTEER.map((v) => (
                <option key={v} value={v}>
                  {v === "none" ? "Jobs: none" : "Jobs: has one"}
                </option>
              ))}
            </Chip>
          )}
          {features.dues && (
            <Chip name="dues" label="Dues" value={params.get("dues")}>
              {DUES.map((v) => (
                <option key={v} value={v}>
                  {`Dues: ${DUES_LABEL[v].toLowerCase()}`}
                </option>
              ))}
            </Chip>
          )}
          <select
            name="sort"
            defaultValue={filters.sort}
            aria-label="Sort by"
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className={chip(false)}
          >
            {SORTS.map((v) => (
              <option key={v} value={v}>
                {SORT_LABEL[v]}
              </option>
            ))}
          </select>
          <details className="relative">
            <summary className={`${chip(false)} cursor-pointer list-none`}>Columns ▾</summary>
            <div className="absolute z-10 mt-1 space-y-1 rounded-lg bg-white p-3 shadow ring-1 ring-dust-light">
              {choosable.map((c) => (
                <label key={c} className="flex items-center gap-2 whitespace-nowrap">
                  <input
                    type="checkbox"
                    name="col"
                    value={c}
                    defaultChecked={columns.includes(c)}
                  />
                  {COLUMN_LABEL[c]}
                </label>
              ))}
              <button type="submit" className={`${btn.secondary} mt-1 w-full py-1 text-sm`}>
                Show columns
              </button>
            </div>
          </details>
        </div>
      </Form>

      {/* The ticked boxes in the table belong to this form (form="roster-selection"). */}
      <Form
        id="roster-selection"
        method="post"
        action="/roster/nudge"
        className="mb-2 flex flex-wrap items-center gap-2 text-sm"
      >
        <input type="hidden" name="search" value={search} />
        <span className="text-charcoal">
          {picked.size ? `${picked.size} picked:` : "With everyone shown:"}
        </span>
        <button
          type="submit"
          className={btn.secondary}
          disabled={!picked.size}
          title={picked.size ? undefined : "Tick the people to nudge first"}
        >
          Nudge picked to RSVP…
        </button>
        <a href={`/roster/export${search}`} className={btn.secondary}>
          Export this view
        </a>
        {picked.size > 0 && (
          <button type="button" className="underline" onClick={() => setPicked(new Set())}>
            Clear ticks
          </button>
        )}
      </Form>

      <p className="mb-2 text-sm text-charcoal">
        {`${rows.length} ${rows.length === 1 ? "person" : "people"}`}
        {filtered && (
          <>
            {" · "}
            <Link to={`/roster?preset=${preset}`} className="underline">
              Clear filters
            </Link>
          </>
        )}
      </p>

      <div className={personId ? "gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem]" : ""}>
        {/* On a phone the person's details take the whole screen; the list waits behind. */}
        <div className={personId ? "hidden lg:block" : ""}>
          {rows.length === 0 ? (
            <p className="text-sm text-charcoal">No one matches.</p>
          ) : (
            groups.map((g) => (
              <div key={g.label ?? "all"} className="mb-5">
                {g.label && (
                  <h2 className="mb-2 font-semibold">
                    {g.label} <span className="font-normal text-charcoal">({g.rows.length})</span>
                  </h2>
                )}
                {/* Phones: one compact line per person. */}
                <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light sm:hidden">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <Link
                        to={open(r.id)}
                        className={`flex items-baseline justify-between gap-3 px-3 py-2.5 ${r.id === personId ? "bg-dust-pale" : ""}`}
                      >
                        <span className="font-medium">{r.name}</span>
                        <span className="text-right text-xs text-charcoal">
                          {[RSVP_LABEL[r.rsvp], day(r.arrivalDate)].filter(Boolean).join(" · ")}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {/* Wider screens: a table with the chosen columns and a header that stays put. */}
                <div className="hidden max-h-[75vh] overflow-auto rounded-xl bg-white ring-1 ring-dust-light sm:block">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-white shadow-[0_1px_0_var(--color-dust-light)]">
                      <tr>
                        <th className="w-8 px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label="Tick everyone shown"
                            checked={g.rows.length > 0 && g.rows.every((r) => picked.has(r.id))}
                            onChange={(e) => {
                              for (const r of g.rows) toggle(r.id, e.target.checked);
                            }}
                          />
                        </th>
                        <th className="px-3 py-2 font-semibold">Camper</th>
                        {columns.map((c) => (
                          <th key={c} className="px-3 py-2 font-semibold">
                            {COLUMN_LABEL[c]}
                          </th>
                        ))}
                        {preset === "no-rsvp" && (
                          <th className="px-3 py-2 font-semibold">Last nudged</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-dust-light">
                      {g.rows.map((r) => (
                        <tr
                          key={r.id}
                          className={r.id === personId ? "bg-dust-pale" : "hover:bg-dust-pale"}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              form="roster-selection"
                              name="id"
                              value={r.id}
                              aria-label={`Tick ${r.name}`}
                              checked={picked.has(r.id)}
                              onChange={(e) => toggle(r.id, e.target.checked)}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <Link
                              to={open(r.id)}
                              aria-current={r.id === personId ? "true" : undefined}
                              className="font-medium underline-offset-2 hover:underline"
                            >
                              {r.name}
                            </Link>
                            {r.name !== r.legalName && (
                              <span className="block text-xs text-charcoal">{r.legalName}</span>
                            )}
                          </td>
                          {columns.map((c) => (
                            <td key={c} className="px-3 py-2 text-charcoal">
                              {cell(r, c)}
                            </td>
                          ))}
                          {preset === "no-rsvp" && (
                            <td className="px-3 py-2 text-charcoal">
                              {r.lastNudgedAt ? new Date(r.lastNudgedAt).toLocaleDateString() : ""}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
        <Outlet />
      </div>
    </section>
  );
}
