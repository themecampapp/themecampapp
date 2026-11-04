// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Headers applied to every response the Worker returns.
// X-Robots-Tag is only set when the route hasn't set its own (public guides opt in to indexing).
// Cache-Control likewise: nothing is stored anywhere (browser or intermediary) unless the route
// says it may be, as public guides, logos and members' photos do. Private pages, route data,
// token links, redirects and errors all get no-store. (Static assets never reach the Worker.)

const directives = (formActions: string[]) => [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  ["form-action 'self'", ...formActions].join(" "),
];
const CSP = directives([]).join("; ");

const FIXED_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// `formActions`: other origins this response's forms may post to. Only the operator console
// needs one (it hands the support token to a camp's /support/enter, R39). A page that posts a
// form to another origin also needs a referrer policy that lets the browser send its Origin:
// under "no-referrer" a cross-origin form POST carries "Origin: null", which the camp Worker
// rightly refuses. "strict-origin" sends only the origin, never the path.
export function withSecurityHeaders(
  response: Response,
  { formActions = [] }: { formActions?: string[] } = {},
): Response {
  // Responses from fetch/redirects can have immutable headers; copy to be safe.
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(FIXED_HEADERS)) {
    secured.headers.set(name, value);
  }
  if (formActions.length) {
    secured.headers.set("Content-Security-Policy", directives(formActions).join("; "));
    secured.headers.set("Referrer-Policy", "strict-origin");
  }
  if (!secured.headers.has("Cache-Control")) {
    secured.headers.set("Cache-Control", "no-store");
  }
  if (!secured.headers.has("X-Robots-Tag")) {
    secured.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return secured;
}
