// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { normalizeHost, platformHostKind } from "~/lib/hosts";

describe("normalizeHost", () => {
  it("lowercases and strips the port and a trailing dot", () => {
    expect(normalizeHost("ThemeCamp.App")).toBe("themecamp.app");
    expect(normalizeHost("themecamp.app:443")).toBe("themecamp.app");
    expect(normalizeHost("themecamp.app.")).toBe("themecamp.app");
    expect(normalizeHost("A.ThemeCamp.App.:8443")).toBe("a.themecamp.app");
  });
});

describe("platformHostKind", () => {
  it("recognises the apex, www and ops hosts", () => {
    expect(platformHostKind("themecamp.app", "themecamp.app")).toBe("public");
    expect(platformHostKind("WWW.themecamp.app.", "themecamp.app")).toBe("www");
    expect(platformHostKind("ops.themecamp.app:443", "themecamp.app")).toBe("ops");
    expect(platformHostKind("Signup.themecamp.app", "themecamp.app")).toBe("signup");
  });

  it("leaves camp hosts, deeper names and other domains to someone else", () => {
    expect(platformHostKind("yellowballoon.themecamp.app", "themecamp.app")).toBeNull();
    expect(platformHostKind("x.ops.themecamp.app", "themecamp.app")).toBeNull();
    expect(platformHostKind("themecamp.app.evil.example", "themecamp.app")).toBeNull();
    expect(platformHostKind("themecamp.dev", "themecamp.app")).toBeNull();
  });
});
