// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { renderMarkdown, safeHref } from "~/lib/markdown.server";

// R29: guide Markdown never becomes markup or a dangerous link.

// No real element but the few Markdown makes, and no event-handler attribute on any element.
const noActiveMarkup = (html: string) => {
  expect(html).not.toMatch(/<(script|iframe|img|svg|object|embed|style|form|input|div)\b/i);
  expect(html).not.toMatch(/<[^>]*\son\w+=/i);
};
const noLinkOrTag = (html: string) => {
  expect(html).not.toMatch(/<a\s/i);
  noActiveMarkup(html);
};

describe("guide Markdown", () => {
  it("renders ordinary formatting", () => {
    const html = renderMarkdown("# Build\n\n**Bring** *water*.\n\n- tent\n- shade");
    expect(html).toContain("<h1>Build</h1>");
    expect(html).toContain("<strong>Bring</strong> <em>water</em>");
    expect(html).toContain("<li>tent</li>");
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=https://evil.example></iframe>",
    "<svg onload=alert(1)>",
    "<style>body{display:none}</style>",
    '<div onclick="alert(1)">x</div>',
    "<form action=https://evil.example><input name=p></form>",
  ])("shows raw HTML as text: %s", (src) => {
    const html = renderMarkdown(src);
    // An https address inside it may become a link (that's allowed); markup never does.
    noActiveMarkup(html);
    expect(html).not.toMatch(/href="(?!https:\/\/)/);
    expect(html).toContain("&lt;");
  });

  it.each([
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](javascript&#58;alert(1))",
    "[x](%6Aavascript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](http://example.com)",
    "[x](//evil.example)",
    "[x](/\\evil.example)",
    "[x](mailto:someone@example.com)",
    "[x](ftp://example.com)",
    "<javascript:alert(1)>",
    "<http://example.com>",
    "[x]: javascript:alert(1)\n\n[y][x]",
    "![x](https://tracker.example/pixel.png)",
  ])("never makes a dangerous or off-policy link: %s", (src) => {
    const html = renderMarkdown(src);
    if (src.startsWith("![")) {
      // Images are off; what's left may be a plain https link, never an image.
      expect(html).not.toMatch(/<img/i);
      return;
    }
    noLinkOrTag(html);
  });

  it.each([
    ["[RSVP](/rsvp)", '<a href="/rsvp" rel="nofollow noopener ugc">RSVP</a>'],
    ["[Top](#top)", '<a href="#top" rel="nofollow noopener ugc">Top</a>'],
    [
      "[BM](https://burningman.org/event/)",
      '<a href="https://burningman.org/event/" rel="nofollow noopener ugc">BM</a>',
    ],
    [
      "see https://burningman.org",
      '<a href="https://burningman.org" rel="nofollow noopener ugc">https://burningman.org</a>',
    ],
  ])("links relative paths and https, with rel set: %s", (src, expected) => {
    expect(renderMarkdown(src)).toContain(expected);
  });

  it("doesn't turn bare http addresses or emails into links", () => {
    const html = renderMarkdown("see http://example.com or write to a@example.com");
    expect(html).not.toMatch(/<a\s/);
  });

  it("checks hrefs strictly", () => {
    for (const ok of ["/rsvp", "/guides/dues#top", "#x", "https://a.example/"]) {
      expect(safeHref(ok), ok).toBe(true);
    }
    for (const bad of [
      "//a.example",
      "/\\a.example",
      "http://a.example",
      "https:a",
      "java\nscript:x",
      "",
    ]) {
      expect(safeHref(bad), bad).toBe(false);
    }
  });
});
