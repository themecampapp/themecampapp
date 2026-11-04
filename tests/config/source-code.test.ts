// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateConfig } from "../../config/schema";
import { readConfig } from "../../scripts/config-to-wrangler";
import { memberRole } from "~/db/schema";
import { INSTANCE } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { startPlatform } from "../helpers/platform";
import { get, invitePerson, signIn, startWorker, type TestWorker } from "../helpers/worker";

// The AGPL (section 13) has an instance offer its source code to everyone who uses it over the
// network. So every instance names it (config product.sourceUrl, required), and every page links
// to it: the camp's pages, signed in or not, Admin → Guide, and the public site.

const LINK = `href="${INSTANCE.SOURCE_URL}"`;

describe("product.sourceUrl", () => {
  const problem = (sourceUrl: unknown) => {
    const config = structuredClone(readConfig("example")) as unknown as {
      product: Record<string, unknown>;
    };
    if (sourceUrl === undefined) delete config.product.sourceUrl;
    else config.product.sourceUrl = sourceUrl;
    try {
      validateConfig(config, "test.json");
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("is required, and must be an https:// address", () => {
    expect(problem(undefined)).toContain("product.sourceUrl is missing");
    expect(problem(null)).toContain("product.sourceUrl must be an https:// address");
    expect(problem("http://code.example.org/fork")).toContain("an https:// address");
    expect(problem("github.com/me/fork")).toContain("an https:// address");
    expect(problem("https://code.example.org/me/fork")).toBeNull();
  });

  it("points the hosted service at the public repository", () => {
    for (const name of ["hosted", "staging"]) {
      expect(readConfig(name).product.sourceUrl, name).toBe(
        "https://github.com/themecampapp/themecampapp",
      );
    }
  });
});

describe("the source code link", () => {
  let t: TestDb;
  let w: TestWorker;
  let admin: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    const p = await invitePerson(t, "source@example.com", { legalName: "Source Admin" });
    await t.db.insert(memberRole).values({ personId: p.id, role: "admin" });
    admin = await signIn(w, "source@example.com");
    await t.client`update camp_settings set agreement_accepted_at = now()`;
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("is on the camp's pages, signed in or not, and in Admin → Guide", async () => {
    for (const [path, cookie] of [
      ["/sign-in", undefined],
      ["/", admin],
      ["/admin/guide", admin],
    ] as const) {
      const res = await w.fetch(get(path, cookie));
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain(LINK);
      expect(html, path).toContain("Source code");
    }
  });

  it("is on the public site's home and legal pages", async () => {
    const platform = await startPlatform(t, "operator@example.com");
    try {
      for (const path of ["/", "/legal/terms"]) {
        const html = await (await platform.site(path)).text();
        expect(html, path).toContain(LINK);
      }
    } finally {
      await platform.dispose();
    }
  });
});
