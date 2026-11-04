// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "~/lib/security-headers";

describe("withSecurityHeaders", () => {
  it("adds noindex and the security headers to every response", () => {
    const response = withSecurityHeaders(new Response("ok"));

    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("keeps a route's own X-Robots-Tag (public guides opt in to indexing)", () => {
    const response = withSecurityHeaders(
      new Response("ok", { headers: { "X-Robots-Tag": "all" } }),
    );

    expect(response.headers.get("X-Robots-Tag")).toBe("all");
  });

  it("preserves status and body, including redirects", async () => {
    const redirect = withSecurityHeaders(
      new Response(null, { status: 302, headers: { Location: "/sign-in" } }),
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe("/sign-in");

    const page = withSecurityHeaders(new Response("hello", { status: 200 }));
    expect(await page.text()).toBe("hello");
  });
});
