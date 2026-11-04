// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure value clean-up, for Leads' CSV imports (U17). No silent coercion: anything we can't
// read confidently is returned as null, and the caller shows the original.

export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

export function normalizeEmail(value: unknown): string | null {
  const s =
    cleanText(value)
      ?.toLowerCase()
      .replace(/^mailto:/, "") ?? null;
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

// Phone cells are often numbers (5109080643, or 5109080643.0 once stringified). Strings are
// kept as typed. Never scientific notation, never an invented country code.
export function normalizePhone(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : null;
  }
  const s = cleanText(value);
  if (!s) return null;
  const floaty = /^(\d+)\.0+$/.exec(s);
  return floaty ? floaty[1] : s;
}

// "Jen Newton “Newtron”" -> { legal: "Jen Newton", playa: "Newtron" }
export function splitQuotedPlaya(name: string): { legal: string; playa: string | null } {
  const m = /^(.*?)\s*[“"]([^”"]+)[”"](.*)$/.exec(name);
  if (!m) return { legal: name, playa: null };
  const legal = cleanText(`${m[1]} ${m[3]}`) ?? name;
  return { legal, playa: cleanText(m[2]) };
}

// "A & B", "A and B", "A / B" usually means two people in one cell.
export function looksLikeMultiplePeople(name: string): boolean {
  return /\s&\s|\sand\s|\//i.test(name);
}

export type YesNo = "yes" | "no" | null;

export function yesNo(value: unknown): YesNo {
  const s = cleanText(value)?.toLowerCase();
  if (!s) return null;
  if (/^(y|yes|yep|yeah|x|true|✔️|✓|have)\b/.test(s)) return "yes";
  if (/^(n|no|nope|false)\b/.test(s)) return "no";
  return null;
}

export const SECTION_LABELS: Array<{ match: RegExp; intent: PreBurnIntent }> = [
  { match: /^yes\s*going/i, intent: "yes_going" },
  { match: /^leaning\s*yes/i, intent: "leaning_yes" },
  { match: /^leaning\s*no/i, intent: "leaning_no" },
  { match: /^no\s*read|not\s*sure/i, intent: "not_sure" },
  { match: /^not\s*going/i, intent: "not_going" },
];

export type PreBurnIntent = "yes_going" | "leaning_yes" | "leaning_no" | "not_sure" | "not_going";

export function sectionIntent(label: string): PreBurnIntent | null {
  return SECTION_LABELS.find((s) => s.match.test(label.trim()))?.intent ?? null;
}

export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A phone number as typed, if it looks like one: 7 to 15 digits, with only the usual
// separators (+ ( ) - . space) and an optional extension. Anything else is null.
export function validPhone(value: unknown): string | null {
  const s = normalizePhone(value);
  if (!s) return null;
  const [main, ext] = s.split(/\s*(?:x|ext\.?|extension)\s*/i);
  if (!/^\+?[\d\s().-]+$/.test(main)) return null;
  const digits = main.replace(/\D/g, "").length;
  if (digits < 7 || digits > 15) return null;
  if (ext !== undefined && !/^\d{1,6}$/.test(ext)) return null;
  return s;
}

// "2019, 2022; 2023" -> the years, and anything that isn't a year from `min` to `max`.
export function parseYears(
  value: unknown,
  { min, max }: { min: number; max: number },
): { years: number[]; bad: string[] } {
  const s = cleanText(value);
  if (!s) return { years: [], bad: [] };
  const years = new Set<number>();
  const bad: string[] = [];
  for (const token of s.split(/[\s,;/|]+/).filter(Boolean)) {
    const y = /^\d{4}$/.test(token) ? Number(token) : Number.NaN;
    if (y >= min && y <= max) years.add(y);
    else bad.push(token);
  }
  return { years: [...years].sort((a, b) => a - b), bad };
}
