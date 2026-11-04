// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads a CSV file the way spreadsheets write them (RFC 4180): commas, "quoted" cells with ""
// for a quote, line breaks inside quotes, CRLF or LF line ends, and an optional byte-order
// mark. Also reads semicolon- or tab-separated files, which some spreadsheet locales export.
// Blank lines are dropped. Throws on an unclosed quote.
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = [",", ";", "\t"].reduce((best, c) =>
    firstLine.split(c).length > firstLine.split(best).length ? c : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (c === "\r" && src[i + 1] === "\n") i++;
    } else cell += c;
    i++;
  }
  if (quoted) throw new Error("unclosed quote");
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}
