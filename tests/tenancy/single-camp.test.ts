// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campOrigin, legalBase, singleCamp } from "~/lib/hosts";
import { campSlugForHost } from "~/lib/tenancy.server";
import { validateConfig } from "../../config/schema";
import { createCamp, createdNotice } from "../../platform/app/lib/camps.server";
import { platformVars, readConfig, wranglerConfig } from "../../scripts/config-to-wrangler";
import { APP_HOST_SUFFIX, APP_URL, stubMail } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { TEST_EMAIL_ENV } from "../helpers/mail";
import { TEST_CAMP_SLUG } from "../helpers/seed";
import {
  get,
  invitePerson,
  requestLinkToken,
  signIn,
  startWorker,
  type TestWorker,
} from "../helpers/worker";

// Open-source plan 3.4: a single-camp instance serves one camp at its own host (config
// singleCamp), and nothing at <slug>.<domain>.

const HOST = "camp.example.org";
const SITE = `https://${HOST}`;
const SINGLE = { SINGLE_CAMP_SLUG: TEST_CAMP_SLUG, SINGLE_CAMP_HOST: HOST };

describe("which camp a host is for", () => {
  const multi = { APP_HOST_SUFFIX, SINGLE_CAMP_SLUG: "", SINGLE_CAMP_HOST: "" };
  const one = { APP_HOST_SUFFIX, ...SINGLE };

  it("is the subdomain on a multi-camp instance", () => {
    expect(singleCamp(multi)).toBeNull();
    expect(campSlugForHost(`dustyowls.${APP_HOST_SUFFIX}`, multi)).toBe("dustyowls");
    expect(campSlugForHost(HOST, multi)).toBeNull();
    expect(campOrigin("dustyowls", APP_HOST_SUFFIX, multi)).toBe(
      `https://dustyowls.${APP_HOST_SUFFIX}`,
    );
    expect(legalBase(multi)).toBe(`https://${APP_HOST_SUFFIX}`);
  });

  it("is the one camp at its host, and none anywhere else, on a single-camp instance", () => {
    expect(campSlugForHost(HOST, one)).toBe(TEST_CAMP_SLUG);
    expect(campSlugForHost("Camp.Example.org.:443", one)).toBe(TEST_CAMP_SLUG);
    expect(campSlugForHost(`${TEST_CAMP_SLUG}.${APP_HOST_SUFFIX}`, one)).toBeNull();
    expect(campSlugForHost(`other.${APP_HOST_SUFFIX}`, one)).toBeNull();
    expect(campSlugForHost(`x.${HOST}`, one)).toBeNull();
    expect(campOrigin(TEST_CAMP_SLUG, APP_HOST_SUFFIX, one)).toBe(SITE);
    expect(legalBase(one)).toBe(SITE);
  });
});

describe("the config", () => {
  const example = () =>
    structuredClone(readConfig("example")) as unknown as Record<string, unknown>;

  it("routes the camp Worker to the host, and gives the platform Worker no routes", () => {
    const c = validateConfig({
      ...example(),
      domain: "example.org",
      singleCamp: { slug: "dustyowls", host: HOST },
    });
    const camps = wranglerConfig("camps", [c]);
    const platform = wranglerConfig("platform", [c]);
    expect(camps.routes).toEqual([{ pattern: `${HOST}/*`, zone_name: "example.org" }]);
    expect(camps.vars).toMatchObject({ SINGLE_CAMP_SLUG: "dustyowls", SINGLE_CAMP_HOST: HOST });
    expect(platform.routes).toEqual([]);
    expect(platform.vars).toMatchObject({ SINGLE_CAMP_SLUG: "dustyowls" });
    expect(platform.triggers.crons).toHaveLength(1);
  });

  it("is unchanged for the hosted service", () => {
    const hosted = readConfig("hosted");
    expect(hosted.singleCamp).toBeNull();
    expect(wranglerConfig("camps", [hosted]).routes).toEqual([
      { pattern: `*.${hosted.domain}/*`, zone_name: hosted.domain },
    ]);
    expect(wranglerConfig("platform", [hosted]).routes).toHaveLength(4);
  });

  it("refuses a host outside the domain, and the console or sign-up page alongside", () => {
    const base = { ...example(), domain: "example.org" };
    expect(() =>
      validateConfig({ ...base, singleCamp: { slug: "dustyowls", host: "camp.other.org" } }),
    ).toThrow(/singleCamp.host must be the domain/);
    expect(() =>
      validateConfig({
        ...base,
        features: { signupPage: false, console: true },
        singleCamp: { slug: "dustyowls", host: "example.org" },
      }),
    ).toThrow(/singleCamp needs features.console/);
    expect(() =>
      validateConfig({ ...base, singleCamp: { slug: "Dusty Owls", host: "example.org" } }),
    ).toThrow(/singleCamp.slug must be a camp slug/);
  });
});

describe("a single-camp instance's camp Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t, SINGLE);
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("serves the camp at its host", async () => {
    const res = await w.fetch(get("/sign-in", undefined, SITE));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Test Camp");
  });

  it("refuses every other host, the camp's own subdomain included", async () => {
    for (const base of [APP_URL, `https://other.${APP_HOST_SUFFIX}`, `https://x.${HOST}`]) {
      const res = await w.fetch(get("/sign-in", undefined, base));
      expect(res.status, base).toBe(404);
      expect(await res.text()).toContain("We couldn't find that camp");
    }
  });

  it("signs people in at its host, with links to it", async () => {
    await invitePerson(t, "solo@example.com");
    const token = await requestLinkToken(w, "solo@example.com", SITE);
    expect(token).not.toBe("");
    expect(w.emails.at(-1)?.text).toContain(`${SITE}/sign-in/confirm`);
    const cookie = await signIn(w, "solo@example.com", SITE);
    const home = await w.fetch(get("/", cookie, SITE));
    expect(home.status).toBe(200);
  });

  it("serves the legal pages itself, and links to them there", async () => {
    const page = await w.fetch(get("/legal/terms", undefined, SITE));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Terms of Service");
    const signin = await (await w.fetch(get("/sign-in", undefined, SITE))).text();
    expect(signin).toContain(`${SITE}/legal/privacy`);
  });
});

describe("a multi-camp instance's camp Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("has no legal pages on a camp's host (they're on the apex)", async () => {
    expect((await w.fetch(get("/legal/terms"))).status).toBe(404);
    const signin = await (await w.fetch(get("/sign-in"))).text();
    expect(signin).toContain(`https://${APP_HOST_SUFFIX}/legal/privacy`);
  });
});

describe("creating a single-camp instance's camp", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.drop());

  it("invites its Admins to its host, and says so", async () => {
    const { sent } = stubMail();
    const env = {
      ...platformVars(readConfig("local")),
      PLATFORM_DOMAIN: APP_HOST_SUFFIX,
      ...TEST_EMAIL_ENV,
      SINGLE_CAMP_SLUG: "dustyowls",
      SINGLE_CAMP_HOST: HOST,
    } as unknown as PlatformEnv;
    const owner = postgres(t.url, { max: 1, onnotice: () => {} });
    try {
      const created = await createCamp(owner, env, "cli", {
        name: "Dusty Owls",
        slug: "dustyowls",
        admins: [{ name: "Olive Owl", email: "owl@example.com" }],
        year: String(new Date().getUTCFullYear() + 1),
      });
      expect(created.site).toBe(SITE);
      expect(createdNotice(created)).toContain(`invited to sign in at ${HOST}`);
      expect(sent[0].text).toContain(`${SITE}/sign-in?email=`);
    } finally {
      await owner.end();
    }
  });
});
