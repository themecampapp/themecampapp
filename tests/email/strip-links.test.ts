// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { REMOVED, stripLinks } from "~/lib/strip-links";

// R62: an announcement's email carries no links but the system's own.
describe("stripLinks", () => {
  it("removes URLs, www addresses, emails and bare domains", () => {
    const { text, removed } = stripLinks(
      "sign up at tix-sale.com or https://evil.test/x?y=1, mail me@example.org, see www.camp.info and xn--bcher-kva.example",
    );
    expect(text).toBe(
      `sign up at ${REMOVED} or ${REMOVED}, mail ${REMOVED}, see ${REMOVED} and ${REMOVED}`,
    );
    expect(removed).toBe(5);
  });

  it("removes 'dot com' spellings and country-code domains", () => {
    expect(stripLinks("tickets at burnersale dot com today").text).toBe(
      `tickets at ${REMOVED} today`,
    );
    expect(stripLinks("go to example (dot) org").text).toBe(`go to ${REMOVED}`);
    expect(stripLinks("bit.ly/abc and site.de").text).toBe(`${REMOVED} and ${REMOVED}`);
  });

  it("leaves ordinary writing alone", () => {
    const plain =
      "Meet at 5.30 p.m., e.g. by the U.S.A. flag. Dues are $250. St. Elmo's fire! Ratio 2.5:1.";
    expect(stripLinks(plain)).toEqual({ text: plain, removed: 0 });
  });
});

describe("punctuation after a link", () => {
  it("stays in the sentence", () => {
    expect(stripLinks("Email x@evil.example. Or see https://a.example/b, then go.").text).toBe(
      "Email [link removed]. Or see [link removed], then go.",
    );
  });
});
