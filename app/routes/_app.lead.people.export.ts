// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data } from "react-router";
import { getViewer } from "~/lib/access.server";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { peopleCsv } from "~/lib/data/export.server";
import type { Route } from "./+types/_app.lead.people.export";

// Lead-only (the _app.lead layout checks first). A download, never cached anywhere.
export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Support access is for looking, not for taking a copy of the camp's member list.
  if (viewer.support) throw data({ reason: "forbidden" }, { status: 403 });
  const csv = await peopleCsv(getDb(context), viewer);
  const { camp } = context.get(cloudflareContext);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${camp.slug}-people-${date}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
