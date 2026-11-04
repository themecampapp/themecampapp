// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data } from "react-router";
import { getViewer } from "~/lib/access.server";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { sapPdfFor } from "~/lib/data/sap.server";
import { inCamp } from "~/lib/files.server";
import type { Route } from "./+types/_app.saps.pass.$id.pdf";

// A Setup Access Pass PDF from the private bucket: for the camper who holds it (while
// approved) and for Leads. Anyone else, and unknown passes, get a 404.
const ID_RE = /^[0-9a-f-]{36}$/;

export async function loader({ params, context }: Route.LoaderArgs) {
  const notFound = () =>
    data({ reason: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!ID_RE.test(params.id)) throw notFound();
  const pass = await sapPdfFor(getDb(context), getViewer(context), params.id);
  const { camp, env } = context.get(cloudflareContext);
  // The row is this camp's (row-level security); the key must be under this camp's prefix too.
  if (!inCamp(camp.id, "sap", pass?.key) || !pass?.key) throw notFound();
  const obj = await env.PHOTOS.get(pass.key);
  if (!obj) throw notFound();
  const name = `SAP-${pass.date}-${pass.serial.replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
