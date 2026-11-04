// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseCsv } from "~/lib/csv";

// A CSV the app wrote (an export), as one record per row keyed by the header, read with the
// app's own parser. Fails if any of `columns` is missing from the header.
export function csvRecords(columns: readonly string[], text: string) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const missing = columns.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`the CSV is missing columns: ${missing.join(", ")}`);
  return rows.map((r) =>
    Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])),
  ) as Array<Record<string, string>>;
}
