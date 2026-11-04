// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { getSettings } from "~/lib/context.server";
import { templateCsv } from "~/lib/data/csv-import.server";
import type { Route } from "./+types/_app.lead.people.import.template";

// R31: the CSV template for importing people: the headings the import reads, and one example
// (with mailing address columns when the camp collects them, issue #78).
export async function loader({ context }: Route.LoaderArgs) {
  const { features } = await getSettings(context);
  return new Response(`﻿${templateCsv(features.mailing)}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="people-import-template.csv"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
