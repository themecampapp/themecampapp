// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { PersonLink } from "~/components/PersonLink";
import { btn, INTENT_LABEL, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import {
  decideSap,
  getSapDays,
  type SapDecision,
  type SapRequestRow,
  sapBoard,
} from "~/lib/data/sap.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.lead.saps";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "SAPs") }];
}

const short = (date: string | null) =>
  date
    ? new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const board = await sapBoard(db);
  return { ...board, days: await getSapDays(db), isAdmin: getViewer(context).isAdmin === true };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const intent = get("intent");
  const decision: SapDecision | null =
    intent === "approve"
      ? { action: "approve", day: get("day") || undefined, passId: get("passId") || undefined }
      : intent === "deny" || intent === "undo" || intent === "release"
        ? { action: intent }
        : null;
  if (!decision) return { error: "Unknown action." };
  const { env } = context.get(cloudflareContext);
  try {
    await decideSap(getDb(context), env, getViewer(context), get("participationId"), decision);
  } catch (e) {
    return formError(e);
  }
  const said = {
    approve: "Approved.",
    deny: "Marked not approved.",
    undo: "Decision undone.",
    release: "Pass released.",
  };
  return redirect(`/saps?notice=${encodeURIComponent(`${get("name")}: ${said[decision.action]}`)}`);
}

type Available = Route.ComponentProps["loaderData"]["available"];

// Choosing a pass: those for the requested day first, then the rest by day.
function PassSelect({ r, available }: { r: SapRequestRow; available: Available }) {
  const wanted = r.approvedDate ?? r.requestedDate;
  const sorted = [...available].sort(
    (a, b) =>
      Number(b.validDate === wanted) - Number(a.validDate === wanted) ||
      a.validDate.localeCompare(b.validDate) ||
      a.serial.localeCompare(b.serial),
  );
  return (
    <select name="passId" defaultValue="" className={`${input} w-auto`} aria-label="Pass">
      <option value="">{r.pass ? "Keep current pass" : "No specific pass yet"}</option>
      {sorted.map((p) => (
        <option key={p.id} value={p.id}>
          {`${short(p.validDate)} · ${p.serial}${p.validDate === wanted ? " ★" : ""}${p.hasPdf ? "" : " (no PDF yet)"}`}
        </option>
      ))}
    </select>
  );
}

function Hidden({ r }: { r: SapRequestRow }) {
  return (
    <>
      <input type="hidden" name="participationId" value={r.participationId} />
      <input type="hidden" name="name" value={r.name} />
    </>
  );
}

type Stock = Route.ComponentProps["loaderData"]["stock"];

function Row({
  r,
  available,
  days,
  stock,
}: {
  r: SapRequestRow;
  available: Available;
  days: string[];
  stock: Stock;
}) {
  // What's left for the day they asked for, so the decision is made with the stock in view.
  const wanted = r.approvedDate ?? r.requestedDate;
  const left = wanted ? (stock.find((s) => s.date === wanted)?.available ?? 0) : null;
  // The season's SAP days, plus an already-approved day that's since been removed from the list.
  const dayOptions = [...new Set([...days, ...(r.approvedDate ? [r.approvedDate] : [])])].sort();
  const small = (intent: string, label: string, danger = false) => (
    <Form method="post">
      <Hidden r={r} />
      <input type="hidden" name="intent" value={intent} />
      <button type="submit" className={`text-sm underline ${danger ? "text-coral-ink" : ""}`}>
        {label}
      </button>
    </Form>
  );
  return (
    <li className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-dust-light">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <PersonLink id={r.personId} className="font-medium underline-offset-2 hover:underline">
          {r.name}
        </PersonLink>
        <span className="text-sm text-charcoal">
          {r.requested
            ? `Asked for ${short(r.requestedDate) ?? "no day given"}${r.arrivalDate ? ` · arriving ${short(r.arrivalDate)}` : ""}${r.status === "pending" && left !== null ? ` · ${left ? `${left} ${left === 1 ? "pass" : "passes"} left that day` : "no passes left that day"}` : ""}`
            : `No longer requesting${r.intent ? ` · ${INTENT_LABEL[r.intent] ?? r.intent}` : " · no RSVP"}`}
        </span>
      </div>
      {r.status === "approved" && (
        <p className="text-sm">
          <span className="font-medium">{`Approved for ${short(r.approvedDate)}`}</span>
          {r.pass
            ? ` · pass ${r.pass.serial}${r.pass.hasPdf ? "" : " (no PDF yet)"}`
            : " · no pass assigned yet"}
          {r.decidedBy && <span className="text-charcoal">{` · by ${r.decidedBy}`}</span>}
        </p>
      )}
      {r.status === "denied" && (
        <p className="text-sm">
          <span className="font-medium">Not approved</span>
          {r.decidedBy && <span className="text-charcoal">{` · by ${r.decidedBy}`}</span>}
        </p>
      )}

      {r.requested && (
        <Form method="post" className="flex flex-wrap items-center gap-2 text-sm">
          <Hidden r={r} />
          <input type="hidden" name="intent" value="approve" />
          {/* With nothing in stock there's no pass to pick: approve the day, assign a pass later. */}
          {available.length > 0 && (
            <>
              <PassSelect r={r} available={available} />
              <span className="text-charcoal">or day</span>
            </>
          )}
          <select
            name="day"
            defaultValue={r.approvedDate ?? r.requestedDate ?? ""}
            aria-label="Approved day"
            className={`${input} w-auto`}
          >
            <option value="">Pick a day</option>
            {dayOptions.map((d) => (
              <option key={d} value={d}>
                {short(d)}
              </option>
            ))}
          </select>
          <button type="submit" className={btn.primary}>
            {r.status === "approved"
              ? "Update"
              : available.length > 0
                ? "Approve and email them"
                : "Approve day; pass later"}
          </button>
        </Form>
      )}
      <div className="flex flex-wrap gap-4">
        {r.requested && r.status !== "denied" && small("deny", "Don't approve", true)}
        {r.pass && small("release", "Release pass")}
        {r.status !== "pending" && small("undo", "Undo decision")}
      </div>
    </li>
  );
}

export default function Saps({ loaderData, actionData }: Route.ComponentProps) {
  const { requests, available, stock, isAdmin, days } = loaderData;
  const [params] = useSearchParams();
  const groups: Array<{ title: string; help?: string; rows: SapRequestRow[]; done?: boolean }> = [
    {
      title: "Plans changed",
      help: "Their RSVP changed after you decided (not coming, withdrew, or a new day). Any pass was released.",
      rows: requests.filter((r) => r.flagged),
    },
    {
      title: "Waiting for a decision",
      rows: requests.filter((r) => !r.flagged && r.status === "pending" && r.requested),
    },
    {
      title: "Approved",
      rows: requests.filter((r) => !r.flagged && r.status === "approved"),
      done: true,
    },
    {
      title: "Not approved",
      rows: requests.filter((r) => !r.flagged && r.status === "denied"),
      done: true,
    },
  ];
  const waiting = groups[1].rows.length + groups[0].rows.length;
  return (
    <section className="space-y-6">
      <PageHeader title="Setup Access Passes">
        {isAdmin && (
          <Link to="/admin/saps" className={btn.secondary}>
            Pass stock
          </Link>
        )}
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        Campers ask for a SAP on their RSVP, with the day they'd like to arrive. Approve with a pass
        for that day (★) or another, or approve for a day and assign a pass later. They're emailed
        when approved, and again when their pass's PDF is ready to download.
      </p>
      <div className="flex flex-wrap gap-2 text-sm">
        {stock.length === 0 ? (
          <span className="text-charcoal">
            No passes in stock yet{isAdmin ? "" : " (an Admin adds them)"}.
          </span>
        ) : (
          stock.map((s) => (
            <span key={s.date} className="rounded-full bg-white px-3 py-1 ring-1 ring-dust">
              {`${short(s.date)}: ${s.available} of ${s.total} left`}
            </span>
          ))
        )}
      </div>

      {groups
        .filter((g) => g.rows.length > 0 || g.title === "Waiting for a decision")
        .map((g) => (
          <details
            key={g.title}
            className="space-y-2"
            // Decided requests fold away while there are still some to decide.
            open={!(g.done && waiting > 0)}
          >
            <summary className="cursor-pointer font-semibold">
              {g.title} <span className="font-normal text-charcoal">({g.rows.length})</span>
            </summary>
            {g.help && <p className="text-sm text-charcoal">{g.help}</p>}
            {g.rows.length === 0 ? (
              <p className="text-sm text-charcoal">No one right now.</p>
            ) : (
              <ul className="space-y-2">
                {g.rows.map((r) => (
                  <Row
                    key={r.participationId}
                    r={r}
                    available={available}
                    days={days}
                    stock={stock}
                  />
                ))}
              </ul>
            )}
          </details>
        ))}
    </section>
  );
}
