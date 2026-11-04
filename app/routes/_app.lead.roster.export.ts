// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data } from "react-router";
import { can, getViewer } from "~/lib/access.server";
import { audit } from "~/lib/audit.server";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { toCsv } from "~/lib/data/export.server";
import { rosterView } from "~/lib/data/season-roster.server";
import { cell } from "~/lib/roster-cells";
import { COLUMN_LABEL } from "~/lib/roster-filters";
import type { Route } from "./+types/_app.lead.roster.export";

// The Roster view on screen, as a CSV (Lead workspace plan, Unit 8): its people and columns,
// worked out again from the query string. Dues only for the Treasurer, formula-safe cells,
// audited like the People export. ("Export all people" stays on People.)
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Support access is for looking, not for taking a copy of the camp's member list.
  if (viewer.support) throw data({ reason: "forbidden" }, { status: 403 });
  const db = getDb(context);
  const { features } = await getSettings(context);
  const treasurer = can(viewer, "dues") && features.dues;
  const search = new URL(request.url).search;
  const { rows, columns, preset } = await rosterView(
    db,
    { dues: treasurer, contact: can(viewer, "private") },
    search,
  );
  const shown = columns.filter(
    (c) =>
      (c !== "sap" || features.saps) &&
      (c !== "volunteer" || features.volunteer) &&
      (c !== "dues" || treasurer),
  );
  await audit(db, {
    actorPersonId: viewer.personId,
    action: "roster_exported",
    subjectType: "person",
    subjectId: null,
    after: { rows: rows.length, view: search.slice(0, 300), dues: shown.includes("dues") },
  });
  const csv = toCsv([
    ["Name", "Playa name", "Email", "Phone", ...shown.map((c) => COLUMN_LABEL[c])],
    ...rows.map((r) => [
      r.legalName,
      r.name === r.legalName ? "" : r.name,
      r.email,
      r.phone,
      ...shown.map((c) => cell(r, c)),
    ]),
  ]);
  const { camp } = context.get(cloudflareContext);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${camp.slug}-roster-${preset}-${date}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
