// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invite, leadQueueItem, memberRole, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

const LEAD_LABEL = /You(?:'|&#x27;|&#39;)re a Lead/;

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

describe("_app access through the real Worker", () => {
  it("redirects an unauthenticated visitor to sign-in", async () => {
    const res = await w.fetch(get("/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in");
  });

  it("links an invited person on first sign-in and shows only their own details", async () => {
    await invitePerson(t, "other@example.com", { legalName: "Other Person", phone: "5550001111" });
    const p = await invitePerson(t, "member@example.com", {
      legalName: "Member Person",
      playaName: "Sparkles",
    });
    const cookie = await signIn(w, "member@example.com");

    const res = await w.fetch(get("/", cookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sparkles");
    expect(html).not.toContain("Other Person");
    expect(html).not.toContain("other@example.com");
    expect(html).not.toContain("5550001111");

    const [linked] = await t.db.select().from(person).where(eq(person.id, p.id));
    expect(linked.authUserId).toBeTruthy();
    const [inv] = await t.db.select().from(invite).where(eq(invite.personId, p.id));
    expect(inv.status).toBe("linked");
  });

  it("gives a login with an ambiguous invite the not-a-member page and queues it for a Lead", async () => {
    await invitePerson(t, "couple@example.com", { legalName: "Partner A" });
    await invitePerson(t, "couple@example.com", { legalName: "Partner B" });
    const cookie = await signIn(w, "couple@example.com");

    const res = await w.fetch(get("/", cookie));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("not on the camp list");
    expect(html).not.toContain("Partner A");

    const queued = await t.db.select().from(leadQueueItem);
    expect(queued.filter((q) => q.kind === "link_conflict")).toHaveLength(1);
    // Visiting again doesn't pile up duplicate queue items.
    await w.fetch(get("/", cookie));
    expect(
      (await t.db.select().from(leadQueueItem)).filter((q) => q.kind === "link_conflict"),
    ).toHaveLength(1);
  });

  it("refuses a deactivated member's existing session on the next request", async () => {
    const p = await invitePerson(t, "leaving@example.com");
    const cookie = await signIn(w, "leaving@example.com");
    expect((await w.fetch(get("/", cookie))).status).toBe(200);

    await t.db.update(person).set({ active: false }).where(eq(person.id, p.id));
    const res = await w.fetch(get("/", cookie));
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin POST before any action runs", async () => {
    await invitePerson(t, "csrf@example.com");
    const cookie = await signIn(w, "csrf@example.com");
    const res = await w.fetch(post("/", {}, { cookie, origin: "https://evil.example" }));
    // React Router's own origin check (400) or our middleware (403): either way, refused.
    expect([400, 403]).toContain(res.status);
  });

  it("shows role labels only from active role rows", async () => {
    const p = await invitePerson(t, "lead@example.com", { playaName: "Captain" });
    await t.db.insert(memberRole).values({ personId: p.id, role: "lead" });
    const cookie = await signIn(w, "lead@example.com");
    expect(await (await w.fetch(get("/", cookie))).text()).toMatch(LEAD_LABEL);

    await t.db
      .update(memberRole)
      .set({ revokedAt: new Date() })
      .where(eq(memberRole.personId, p.id));
    expect(await (await w.fetch(get("/", cookie))).text()).not.toMatch(LEAD_LABEL);
  });
});
