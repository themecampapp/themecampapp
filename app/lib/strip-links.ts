// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Removes links and anything a mail app would turn into one, from text a Lead wrote that goes
// out by email (R62: an announcement's email carries only the system's own link). It errs on
// the side of removing: a URL, "www." anything, an email address, a domain-like word ending in
// a known top-level domain (or any two-letter country code, or punycode), and "example dot com"
// style spellings. Ordinary abbreviations ("e.g.", "5.30", "a.m.", "U.S.A.") are left alone.

export const REMOVED = "[link removed]";

const TLDS = [
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "mil",
  "int",
  "io",
  "co",
  "app",
  "dev",
  "me",
  "info",
  "biz",
  "xyz",
  "online",
  "site",
  "store",
  "shop",
  "club",
  "live",
  "life",
  "link",
  "click",
  "art",
  "camp",
  "events",
  "tickets",
  "page",
  "web",
  "blog",
  "tech",
  "cloud",
  "ly",
  "gg",
  "tv",
  "fm",
  "ai",
  "so",
  "to",
  "sh",
  "zone",
  "world",
  "today",
  "space",
  "fun",
  "party",
  "social",
  "email",
  "news",
  "media",
  "group",
  "team",
  "network",
  "center",
  "community",
  "earth",
].join("|");

const PATTERNS: RegExp[] = [
  // Anything with a scheme: https://…, mailto:…, ftp://…
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  /\bmailto:\S+/gi,
  /\bwww\.\S+/gi,
  // Email addresses.
  /[^\s@]+@[^\s@]+\.[^\s@]+/g,
  // example.com, sub.example.co.uk/path, xn--bcher-kva.example
  new RegExp(
    `\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS}|[a-z]{2}|xn--[a-z0-9-]+)\\b(?:[/?#]\\S*)?`,
    "gi",
  ),
  // Any word with a punycode label (an internationalised domain), whatever it ends in.
  /\S*\bxn--[a-z0-9-]+\.\S+/gi,
  // example dot com, example (dot) com, example[dot]com
  new RegExp(`\\b[a-z0-9-]+\\s*[([]?\\s*dot\\s*[)\\]]?\\s*(?:${TLDS})\\b`, "gi"),
];

export function stripLinks(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match) => {
      removed++;
      // A sentence's closing punctuation isn't part of the link: keep it.
      return REMOVED + (match.match(/[.,;:!?)\]'"]+$/)?.[0] ?? "");
    });
  }
  return { text: out, removed };
}
