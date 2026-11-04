// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { textToHtml } from "~/lib/email-html";

describe("textToHtml", () => {
  it("escapes everything, keeps paragraphs and lines, and links only the app's own link", () => {
    const html = textToHtml(
      'Hi <b>there</b> & "friends"\nline two\n\nSign in: https://camp.x/sign-in?a=1&b=2',
      "https://camp.x/sign-in?a=1&b=2",
    );
    expect(html).toContain(
      "<p>Hi &lt;b&gt;there&lt;/b&gt; &amp; &quot;friends&quot;<br>line two</p>",
    );
    expect(html).toContain(
      '<p>Sign in: <a href="https://camp.x/sign-in?a=1&amp;b=2">https://camp.x/sign-in?a=1&amp;b=2</a></p>',
    );
  });

  it("never turns anything else into a link", () => {
    const html = textToHtml("See https://evil.example now", "javascript:alert(1)");
    expect(html).not.toContain("<a ");
    expect(textToHtml("x", "")).not.toContain("<a ");
  });
});
