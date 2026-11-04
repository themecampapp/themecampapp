// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole, person } from "~/db/schema";
import { ORIENTATION_STEPS, orientationStart, orientationSteps } from "~/lib/orientation";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #65: the Lead and Admin orientation. The tour itself runs in the browser; these check
// where it starts, what's saved on Pause, Stop and finish, and who gets it.

describe("where the orientation starts", () => {
  const firstAdmin = ORIENTATION_STEPS.find((s) => s.admin)?.key;

  it("starts at the beginning for anyone who hasn't finished or stopped it", () => {
    expect(orientationStart("lead", null, null)).toBe("welcome");
    expect(orientationStart("admin", null, null)).toBe("welcome");
  });

  it("picks up where it was paused, if that step is in their tour", () => {
    expect(orientationStart("lead", null, "people")).toBe("people");
    expect(orientationStart("lead", null, "season")).toBe("welcome"); // an Admin step
    expect(orientationStart("admin", null, "season")).toBe("season");
    expect(orientationStart("lead", null, "gone")).toBe("welcome");
  });

  it("doesn't start once done, except the Admin steps for a Lead made Admin", () => {
    expect(orientationStart("lead", "lead", null)).toBeNull();
    expect(orientationStart("lead", "admin", null)).toBeNull();
    expect(orientationStart("admin", "admin", "people")).toBeNull();
    expect(orientationStart("admin", "lead", null)).toBe(firstAdmin);
  });

  it("gives Leads the day-to-day steps and Admins the setup steps too", () => {
    const lead = orientationSteps("lead").map((s) => s.key);
    const admin = orientationSteps("admin").map((s) => s.key);
    expect(lead).not.toContain("admin");
    expect(admin).toEqual(expect.arrayContaining([...lead, "admin", "season"]));
    expect(lead.at(-1)).toBe("done");
    expect(admin.at(-1)).toBe("done");
  });
});

describe("the orientation through the real Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  const cookie: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    for (const [key, roles] of [
      ["member", []],
      ["lead", ["lead"]],
      ["admin", ["admin"]],
    ] as const) {
      const p = await invitePerson(t, `${key}@example.com`, { legalName: `${key} Person` });
      ids[key] = p.id;
      for (const role of roles) await t.db.insert(memberRole).values({ personId: p.id, role });
      cookie[key] = await signIn(w, `${key}@example.com`);
    }
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  const saved = async (key: string) => {
    const [p] = await t.db
      .select({ done: person.orientationDone, step: person.orientationStep })
      .from(person)
      .where(eq(person.id, ids[key]));
    return p;
  };
  const send = (who: string, fields: Record<string, string>) =>
    w.fetch(post("/orientation", fields, { cookie: cookie[who] }));

  it("marks the links the tour points at, and offers 'Take the tour' to Leads only", async () => {
    const lead = await (await w.fetch(get("/", cookie.lead))).text();
    for (const anchor of ["home-view", "roster", "people", "queue", "tour-link"]) {
      expect(lead).toContain(`data-tour="${anchor}"`);
    }
    expect(lead).toContain("Take the tour");
    expect(lead).toContain("data-mobile-menu");
    const admin = await (await w.fetch(get("/", cookie.admin))).text();
    expect(admin).toContain('data-tour="admin"');
    const member = await (await w.fetch(get("/", cookie.member))).text();
    expect(member).not.toContain("Take the tour");
    expect(member).not.toContain('data-tour="roster"');
  });

  it("remembers the step it was paused on", async () => {
    expect((await send("lead", { intent: "pause", step: "people" })).status).toBe(200);
    expect(await saved("lead")).toEqual({ done: null, step: "people" });
    expect((await send("lead", { intent: "pause", step: "nope" })).status).toBe(400);
    expect(await saved("lead")).toEqual({ done: null, step: "people" });
  });

  it("records Stop or finishing at the person's level, so it doesn't start again", async () => {
    await send("lead", { intent: "stop" });
    expect(await saved("lead")).toEqual({ done: "lead", step: null });
    await send("admin", { intent: "finish" });
    expect(await saved("admin")).toEqual({ done: "admin", step: null });
  });

  it("is for Leads and Admins only", async () => {
    expect((await send("member", { intent: "stop" })).status).toBe(403);
    expect(await saved("member")).toEqual({ done: null, step: null });
    expect((await send("lead", { intent: "skip" })).status).toBe(400);
  });
});
