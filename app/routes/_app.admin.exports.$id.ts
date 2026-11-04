// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, gt, sql } from "drizzle-orm";
import { data } from "react-router";
import { campExport } from "~/db/schema";
import { getViewer } from "~/lib/access.server";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { inCamp } from "~/lib/files.server";
import type { Route } from "./+types/_app.admin.exports.$id";

// Downloads one of the camp's full exports (Admins only, via the admin layout). The row is
// this camp's (row-level security) and its file is under this camp's prefix.
export async function loader({ params, context }: Route.LoaderArgs) {
  const notFound = () =>
    data({ reason: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  // Support access looks; it doesn't take a copy of the camp.
  if (getViewer(context).support) throw data({ reason: "forbidden" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/.test(params.id)) throw notFound();
  const [row] = await getDb(context)
    .select({ key: campExport.key, createdAt: campExport.createdAt })
    .from(campExport)
    .where(and(eq(campExport.id, params.id), gt(campExport.expiresAt, sql`now()`)));
  const { camp, env } = context.get(cloudflareContext);
  if (!row || !inCamp(camp.id, "exports", row.key)) throw notFound();
  const obj = await env.PHOTOS.get(row.key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${camp.slug}-export-${row.createdAt.toISOString().slice(0, 10)}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
