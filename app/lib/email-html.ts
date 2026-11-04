// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Providers take an HTML body (the plain text goes alongside it), while our emails are
// written as plain text. Everything is escaped, so wording an Admin typed can never become
// markup; paragraphs and line breaks are kept; and only the system's own link, which the app
// built, is made clickable.
const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function textToHtml(text: string, link?: string): string {
  const safeLink = link && /^https:\/\/[^\s"'<>]+$/.test(link) ? escapeHtml(link) : null;
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => {
      let html = escapeHtml(p).replaceAll("\n", "<br>");
      if (safeLink) html = html.replaceAll(safeLink, `<a href="${safeLink}">${safeLink}</a>`);
      return `<p>${html}</p>`;
    });
  return `<!doctype html><html><body style="font-family:sans-serif;font-size:15px;line-height:1.5">${paragraphs.join("\n")}</body></html>`;
}
