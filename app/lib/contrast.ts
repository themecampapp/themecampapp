// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The accent colour sits behind dark text (buttons, highlights), so it must keep that text
// readable: WCAG AA, a contrast ratio of at least 4.5:1 against the app's text colour.

export const TEXT_COLOR = "#1a1714"; // --color-night in app.css
export const MIN_CONTRAST = 4.5;

const HEX_RE = /^#[0-9a-f]{6}$/;

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A lowercase #rrggbb, or null when it isn't a colour.
export function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const full = /^#[0-9a-f]{3}$/.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v;
  return HEX_RE.test(full) ? full : null;
}

export const readableAccent = (hex: string) => contrastRatio(hex, TEXT_COLOR) >= MIN_CONTRAST;
