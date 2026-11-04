// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type CampRef, campReadOnly, campSlugFromHost } from "~/lib/tenancy.server";

const SUFFIX = "themecamp.app";

describe("campSlugFromHost", () => {
  it("takes the one label before the suffix", () => {
    expect(campSlugFromHost("yellowballoon.themecamp.app", SUFFIX)).toBe("yellowballoon");
    expect(campSlugFromHost("dusty-owls.themecamp.app", SUFFIX)).toBe("dusty-owls");
  });

  it("ignores case, a port and a trailing dot", () => {
    expect(campSlugFromHost("YellowBalloon.ThemeCamp.App.", SUFFIX)).toBe("yellowballoon");
    expect(campSlugFromHost("yellowballoon.themecamp.app:443", SUFFIX)).toBe("yellowballoon");
  });

  it("refuses the apex, deeper names, bad labels and other domains", () => {
    for (const host of [
      "themecamp.app",
      "x.yellowballoon.themecamp.app",
      "-bad.themecamp.app",
      "bad-.themecamp.app",
      "under_score.themecamp.app",
      "yellowballoon.themecamp.app.evil.example",
      "yellowballoonthemecamp.app",
      "yellowballoon.themecamp.dev",
      "",
    ]) {
      expect(campSlugFromHost(host, SUFFIX), host).toBeNull();
    }
  });
});

describe("campReadOnly", () => {
  const camp = (kind: CampRef["kind"], status: CampRef["status"]): CampRef => ({
    id: "00000000-0000-4000-8000-000000000009",
    slug: "x",
    kind,
    status,
  });

  it("lets an active camp write", () => {
    expect(campReadOnly(camp("camp", "active"), false)).toBe(false);
  });

  it("keeps a suspended camp read-only except for sign-in writes", () => {
    expect(campReadOnly(camp("camp", "suspended"), false)).toBe(true);
    expect(campReadOnly(camp("camp", "suspended"), true)).toBe(false);
  });

  it("never lets a demo camp write", () => {
    expect(campReadOnly(camp("demo", "active"), false)).toBe(true);
    expect(campReadOnly(camp("demo", "active"), true)).toBe(true);
  });
});
