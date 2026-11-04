// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import routes from "~/routes";

// Every route must be public by explicit listing here, or nested under the _app layout
// (whose middleware requires an active member). Adding a top-level route fails CI until
// someone decides deliberately that it's public.
const PUBLIC_FILES = new Set([
  "routes/sign-in.tsx",
  "routes/sign-in.check-email.tsx",
  "routes/sign-in.confirm.tsx",
  "routes/sign-in.error.tsx",
  "routes/sign-out.ts",
  "routes/api.auth.$.ts",
  "routes/email.confirm.tsx",
  "routes/email.approve.tsx",
  "routes/join.tsx",
  "routes/join.thanks.tsx",
  // The camp logo: shown on the sign-in page, so it can't need a session.
  "routes/logo.$name.ts",
  // Support access: token-authenticated (enter) and cookie-clearing (leave).
  "routes/support.enter.ts",
  "routes/support.leave.ts",
  // The public demo camp's way in (R67); a 404 on every other camp.
  "routes/demo.enter.tsx",
  "routes/confirm.request.$token.tsx",
  "routes/guides._index.tsx",
  "routes/guides.$slug.tsx",
  // A single-camp instance's legal pages (3.4); a 404 on every other instance.
  "routes/legal.$doc.tsx",
]);

type Entry = { file: string; children?: Entry[] };

describe("route config", () => {
  it("nests every non-public route under the _app layout", () => {
    const unguarded: string[] = [];
    for (const entry of routes as Entry[]) {
      if (entry.file === "routes/_app.tsx") continue;
      if (!PUBLIC_FILES.has(entry.file)) unguarded.push(entry.file);
      if (entry.children?.length) unguarded.push(...entry.children.map((c) => c.file));
    }
    expect(unguarded).toEqual([]);
  });

  it("keeps the _app layout at the top level", () => {
    expect((routes as Entry[]).some((r) => r.file === "routes/_app.tsx")).toBe(true);
  });

  it("keeps every _app.lead.* page inside the Lead-only layout", () => {
    const misplaced: string[] = [];
    const walk = (entries: Entry[], underLead: boolean) => {
      for (const e of entries) {
        const lead = underLead || e.file === "routes/_app.lead.tsx";
        if (e.file.startsWith("routes/_app.lead.") && !lead) misplaced.push(e.file);
        if (e.children) walk(e.children, lead);
      }
    };
    walk(routes as Entry[], false);
    expect(misplaced).toEqual([]);
  });
});
