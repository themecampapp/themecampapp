// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, memberRole, participation } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { readCapped } from "~/lib/body-limit";
import { recordDues } from "~/lib/data/dues.server";
import { APP_URL } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Findings S2, S3 and S5 of the September 30 security review.

let t: TestDb;
let w: TestWorker;
let lead: string;
let treasurer: string;
let camperId: string;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  const tr = await invitePerson(t, "treasurer@example.com", { legalName: "Tia Treasurer" });
  await t.db.insert(memberRole).values([
    { personId: tr.id, role: "lead" },
    { personId: tr.id, role: "treasurer" },
  ]);
  const c = await invitePerson(t, "camper@example.com", { legalName: "Cam Camper" });
  camperId = c.id;
  const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  await t.db.insert(participation).values({ personId: c.id, burnId: season.id, intent: "going" });
  const asTreasurer: Viewer = {
    personId: tr.id,
    authUserId: "x",
    legalName: tr.legalName,
    playaName: null,
    ...asRoles(["lead", "treasurer"]),
  };
  await recordDues(t.db, asTreasurer, c.id, {
    status: "paid",
    amount: "12345",
    paidOn: "2027-02-01",
    method: "venmo",
  });
  lead = await signIn(w, "lead@example.com");
  treasurer = await signIn(w, "treasurer@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("S2: dues in a person's history", () => {
  it("are left out for a Lead who isn't the Treasurer, in the page and its route data", async () => {
    for (const path of [`/people/${camperId}`, `/people/${camperId}?history=all`]) {
      const html = await (await w.fetch(get(path, lead))).text();
      expect(html, path).toContain("Cam Camper");
      expect(html, path).not.toMatch(/Dues recorded|12,345/);
    }
    const data = await (await w.fetch(get(`/people/${camperId}.data`, lead))).text();
    expect(data).not.toMatch(/Dues recorded|12,345|dues_updated/);
  });

  it("are there for the Treasurer", async () => {
    const html = await (await w.fetch(get(`/people/${camperId}`, treasurer))).text();
    expect(html).toContain("Dues recorded as paid ($12,345)");
  });
});

describe("S3: caching", () => {
  it("stores no private page, route data, token link or redirect anywhere", async () => {
    for (const [path, cookie] of [
      ["/people", lead],
      ["/people.data", lead],
      [`/people/${camperId}`, lead],
      ["/", lead],
      ["/", ""], // the redirect to sign-in
      ["/email/confirm?token=review-placeholder", ""],
      ["/sign-in/confirm?token=review-placeholder", ""],
      ["/sign-in", ""],
    ] as const) {
      const res = await w.fetch(get(path, cookie));
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      await res.text();
    }
  });

  it("keeps the caching routes ask for", async () => {
    const res = await w.fetch(get("/guides", lead));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    await res.text();
  });
});

describe("S5: upload size", () => {
  it("reads a body that doesn't declare its size only up to the limit", async () => {
    const stream = (chunks: number, size: number) => {
      let n = 0;
      let pulled = 0;
      return {
        pulled: () => pulled,
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++;
            if (n++ >= chunks) c.close();
            else c.enqueue(new Uint8Array(size).fill(7));
          },
        }),
      };
    };
    const small = stream(3, 10);
    expect(await readCapped(small.body, 100)).toEqual(new Uint8Array(30).fill(7));
    // Past the limit: null, and the rest is never read.
    const big = stream(1000, 10);
    expect(await readCapped(big.body, 25)).toBeNull();
    expect(big.pulled()).toBeLessThan(10);
  });

  it("refuses a body over the limit before reading it", async () => {
    const big = new Uint8Array(6 * 1024 * 1024 + 1);
    const send = () =>
      w.fetch(
        new Request(`${APP_URL}/profile`, {
          method: "POST",
          headers: {
            origin: APP_URL,
            cookie: lead,
            "content-type": "application/octet-stream",
            "content-length": String(big.byteLength),
          },
          body: big,
        }),
      );
    // The Worker answers before reading the body (that's the point), so the test client can
    // find the connection closed while it's still writing (EPIPE) and never see the 413. Try
    // a few times; one of them gets the answer.
    let res: Response | null = null;
    for (let i = 0; i < 5 && !res; i++) res = await send().catch(() => null);
    if (!res) throw new Error("no response in 5 tries");
    expect(res.status).toBe(413);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // The connection may already be closed under the body too ("terminated"): only the status
    // and headers matter here.
    await res.text().catch(() => "");
  });

  it("refuses a photo over its own limit without reading it", async () => {
    const form = new FormData();
    form.set("intent", "photo_upload");
    form.set(
      "photo",
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "me.jpg", { type: "image/jpeg" }),
    );
    const res = await w.fetch(
      new Request(`${APP_URL}/profile`, {
        method: "POST",
        headers: { origin: APP_URL, cookie: lead },
        body: form,
      }),
    );
    expect(await res.text()).toContain("That photo is too big (5 MB max)");
  });

  it("still takes an ordinary form", async () => {
    const res = await w.fetch(
      post("/profile", { intent: "details", phone: "555-555-0100" }, { cookie: lead }),
    );
    expect(res.status).toBeLessThan(400);
    await res.text();
  });
});
