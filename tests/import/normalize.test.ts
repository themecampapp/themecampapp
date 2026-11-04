// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseCsv } from "~/lib/csv";
import {
  looksLikeMultiplePeople,
  normalizeEmail,
  normalizePhone,
  parseYears,
  sectionIntent,
  splitQuotedPlaya,
  validPhone,
  yesNo,
} from "~/lib/import/normalize";

describe("importer normalization", () => {
  it("turns numeric and float-looking phones into digit strings, never scientific notation", () => {
    expect(normalizePhone(5109080643)).toBe("5109080643");
    expect(normalizePhone("5109080643.0")).toBe("5109080643");
    expect(normalizePhone("203-984-0860")).toBe("203-984-0860");
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("  ")).toBeNull();
    expect(normalizePhone(5.1e9 + 0.5)).toBeNull();
  });

  it("normalizes emails and rejects junk", () => {
    expect(normalizeEmail(" Alex@Example.COM ")).toBe("alex@example.com");
    expect(normalizeEmail("mailto:a@b.co")).toBe("a@b.co");
    expect(normalizeEmail("not an email")).toBeNull();
  });

  it("maps roster section labels to pre-burn intent", () => {
    expect(sectionIntent("Yes Going")).toBe("yes_going");
    expect(sectionIntent("Leaning Yes")).toBe("leaning_yes");
    expect(sectionIntent("Leaning No")).toBe("leaning_no");
    expect(sectionIntent("No Read / Not Sure")).toBe("not_sure");
    expect(sectionIntent("Not Going/Not Yellow Balloon")).toBe("not_going");
    expect(sectionIntent("Alex Alpha")).toBeNull();
  });

  it("pulls a quoted playa name out of a name cell, but not apostrophes", () => {
    expect(splitQuotedPlaya("Jen Newton “Newtron”")).toEqual({
      legal: "Jen Newton",
      playa: "Newtron",
    });
    expect(splitQuotedPlaya("Jill O'Neill")).toEqual({ legal: "Jill O'Neill", playa: null });
  });

  it("spots cells that name two people", () => {
    expect(looksLikeMultiplePeople("Eli & Fran")).toBe(true);
    expect(looksLikeMultiplePeople("Emily/phoenix")).toBe(true);
    expect(looksLikeMultiplePeople("Andrew Anderson")).toBe(false);
  });

  it("reads yes/no answers without guessing at prose", () => {
    expect(yesNo("YES")).toBe("yes");
    expect(yesNo("Yep")).toBe("yes");
    expect(yesNo("no")).toBe("no");
    expect(yesNo("maybe later")).toBeNull();
  });
});

describe("CSV import values (U17)", () => {
  it("keeps phone numbers as typed, and refuses what isn't one", () => {
    for (const ok of ["555-555-0101", "(510) 908-0643", "+44 20 7946 0958", "5109080643 x12"]) {
      expect(validPhone(ok), ok).toBe(ok);
    }
    for (const bad of ["call me", "12345", "555-555-0101-555-555-0101", "555 0101 ext abc"]) {
      expect(validPhone(bad), bad).toBeNull();
    }
  });

  it("reads past years in any list form, and says what it couldn't use", () => {
    const range = { min: 1990, max: 2026 };
    expect(parseYears("2019, 2022; 2023", range)).toEqual({ years: [2019, 2022, 2023], bad: [] });
    expect(parseYears("2023 2023/2021", range)).toEqual({ years: [2021, 2023], bad: [] });
    expect(parseYears("2027, '22, 1985", range)).toEqual({
      years: [],
      bad: ["2027", "'22", "1985"],
    });
    expect(parseYears("", range)).toEqual({ years: [], bad: [] });
  });
});

describe("parseCsv", () => {
  it("reads what spreadsheets write: quotes, commas and line breaks in cells, CRLF, a BOM", () => {
    const text = '﻿Name,Home\r\n"Rivera, Alex","Oakland,\nCA"\r\n"Say ""hi""",x\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["Name", "Home"],
      ["Rivera, Alex", "Oakland,\nCA"],
      ['Say "hi"', "x"],
    ]);
  });

  it("reads semicolon- and tab-separated files too", () => {
    expect(parseCsv("Name;Email\nAl;a@x.com\n")).toEqual([
      ["Name", "Email"],
      ["Al", "a@x.com"],
    ]);
    expect(parseCsv("Name\tEmail\nAl\ta@x.com")).toEqual([
      ["Name", "Email"],
      ["Al", "a@x.com"],
    ]);
  });

  it("refuses an unclosed quote", () => {
    expect(() => parseCsv('Name\n"Al')).toThrow();
  });
});
