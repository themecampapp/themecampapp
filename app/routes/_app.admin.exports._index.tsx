// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { desc, gt, sql } from "drizzle-orm";
import { Link } from "react-router";
import { Notice, PageHeader } from "~/components/ui";
import { campExport } from "~/db/schema";
import { pageTitle, useCamp } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import type { Route } from "./+types/_app.admin.exports._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Exports · Admin") }];
}

// R43: full exports Theme Camp App made on an Admin's confirmed request, downloadable here for
// 7 days. They never go out by email.
export async function loader({ context }: Route.LoaderArgs) {
  const rows = await getDb(context)
    .select({
      id: campExport.id,
      bytes: campExport.bytes,
      createdAt: campExport.createdAt,
      expiresAt: campExport.expiresAt,
    })
    .from(campExport)
    .where(gt(campExport.expiresAt, sql`now()`))
    .orderBy(desc(campExport.createdAt));
  return {
    exports: rows.map((r) => ({
      id: r.id,
      kb: Math.ceil(r.bytes / 1024),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    })),
  };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function Exports({ loaderData }: Route.ComponentProps) {
  const { productName } = useCamp();
  return (
    <section className="max-w-2xl space-y-4">
      <PageHeader title="Exports" />
      <p className="text-sm text-charcoal">
        A full export is a zip of every record the camp has, as spreadsheets (CSV), plus its photos,
        pass PDFs and logo. {productName} makes one when an Admin asks for it (email support), and
        it's here for 7 days. For everyday lists, use the exports on each page, such as People →
        Export.
      </p>
      {loaderData.exports.length === 0 ? (
        <Notice>No exports right now.</Notice>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
          {loaderData.exports.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="text-sm">{`Made ${when(e.createdAt)} · ${e.kb} KB · until ${when(e.expiresAt)}`}</span>
              <Link
                to={`/admin/exports/${e.id}`}
                reloadDocument
                className="text-sm font-semibold underline"
              >
                Download
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
