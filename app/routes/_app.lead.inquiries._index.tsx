// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { btn, INQUIRY_LABEL, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import {
  closeMatchedImportedInquiries,
  type InquiryStatus,
  listInquiries,
  matchedImportedInquiries,
} from "~/lib/data/inquiries.server";
import type { Route } from "./+types/_app.lead.inquiries._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Inquiries") }];
}

const TABS: Array<InquiryStatus | "open" | "all"> = [
  "open",
  "new",
  "contacted",
  "met",
  "invited",
  "declined",
  "all",
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const param = new URL(request.url).searchParams.get("status") ?? "open";
  const status = (TABS as string[]).includes(param) ? (param as (typeof TABS)[number]) : "open";
  const db = getDb(context);
  const { rows, counts } = await listInquiries(db, status);
  return {
    status,
    counts,
    matchedImported: (await matchedImportedInquiries(db)).length,
    rows: rows.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString() })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") !== "close_matched") return { error: "Unknown action." };
  const n = await closeMatchedImportedInquiries(getDb(context), getViewer(context));
  return redirect(
    `/inquiries?notice=${encodeURIComponent(`Closed ${n} imported inquiries as existing campers. No emails were sent.`)}`,
  );
}

export default function Inquiries({ loaderData }: Route.ComponentProps) {
  const { rows, counts, status } = loaderData;
  const [params] = useSearchParams();
  const open = (counts.new ?? 0) + (counts.contacted ?? 0) + (counts.met ?? 0);
  return (
    <section>
      <PageHeader title="Newcomer inquiries" />
      {params.get("notice") && (
        <div className="mb-3">
          <Notice tone="ok">{params.get("notice")}</Notice>
        </div>
      )}
      {loaderData.matchedImported > 0 && (
        <Form method="post" className="mb-4 space-y-2 rounded-xl bg-gold-glow p-4 ring-1 ring-gold">
          <input type="hidden" name="intent" value="close_matched" />
          <p className="text-sm">
            {`${loaderData.matchedImported} imported inquiries belong to people who are already in the app (matched by email). Closing them links each inquiry to that person and sends nothing. They'll be invited later with the other returning campers.`}
          </p>
          <button type="submit" className={btn.primary}>
            {`Close ${loaderData.matchedImported} as existing campers (no emails)`}
          </button>
        </Form>
      )}
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Filter inquiries">
        {TABS.map((t) => (
          <Link
            key={t}
            to={`?status=${t}`}
            className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${status === t ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
          >
            {t === "open" ? "Open" : t === "all" ? "All" : INQUIRY_LABEL[t]}
            <span className="ml-1 opacity-70">
              {t === "open"
                ? open
                : t === "all"
                  ? Object.values(counts).reduce((a, b) => a + b, 0)
                  : (counts[t] ?? 0)}
            </span>
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Notice>No inquiries here.</Notice>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                to={`/inquiries/${r.id}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-dust-pale"
              >
                <span>
                  <span className="font-semibold">{r.name}</span>
                  {r.playaName && <span className="ml-2 text-sm text-charcoal">{r.playaName}</span>}
                  <span className="block text-sm text-charcoal">{r.email ?? "no email"}</span>
                </span>
                <span className="text-right text-sm">
                  <span className="block font-medium">{INQUIRY_LABEL[r.status]}</span>
                  <span className="block text-charcoal">
                    {new Date(r.receivedAt).toLocaleDateString()}
                    {r.assignedTo && ` · ${r.assignedTo}`}
                    {r.source === "import" && " · imported"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
