// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import MarkdownIt from "markdown-it";

// Guide Markdown, rendered on the server (R29). Raw HTML is never rendered (it shows as
// text). Links, typed or auto-detected, may only be relative paths within the camp's site
// ("/rsvp", "#section") or https URLs; anything else (javascript:, data:, http:, mailto:,
// protocol-relative "//host") stays as plain text. Every link gets rel="nofollow noopener ugc".
// Images are off: a guide can't make readers' browsers fetch something from elsewhere.

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
md.disable("image");

export function safeHref(url: string): boolean {
  const u = url.trim();
  if (u.startsWith("#")) return true;
  // Not "//host" or "/\\host" (browsers read both as another site), even percent-encoded.
  if (u.startsWith("/")) return !/^\/(\/|\\|%5c|%2f)/i.test(u);
  return /^https:\/\/[^\s/\\]/i.test(u);
}

md.validateLink = safeHref;
// Auto-detected links (linkify) are validated the same way; only https ones become links.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("rel", "nofollow noopener ugc");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(body: string): string {
  return md.render(body);
}
