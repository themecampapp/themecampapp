// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole, person, volunteerRole, volunteerSignup } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { signUp } from "~/lib/data/volunteer.server";
import { csvRecords } from "../helpers/csv";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

async function role(title: string) {
  const [r] = await t.db.select().from(volunteerRole).where(eq(volunteerRole.title, title));
  return r;
}
async function signedUp(title: string) {
  const r = await role(title);
  return (
    await t.db
      .select({ name: person.playaName })
      .from(volunteerSignup)
      .innerJoin(person, eq(person.id, volunteerSignup.personId))
      .where(eq(volunteerSignup.roleId, r.id))
  )
    .map((x) => x.name)
    .sort();
}
const join = async (who: string, title: string) =>
  w.fetch(
    post(
      "/volunteer",
      { intent: "join", roleId: (await role(title)).id, title },
      { cookie: cookie[who] },
    ),
  );

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const make = async (key: string, roles: Array<"lead" | "admin"> = []) => {
    const p = await invitePerson(t, `${key}@example.com`, {
      legalName: `${key} Person`,
      playaName: key,
    });
    ids[key] = p.id;
    for (const r of roles) await t.db.insert(memberRole).values({ personId: p.id, role: r });
    cookie[key] = await signIn(w, `${key}@example.com`);
    await w.fetch(get("/", cookie[key]));
  };
  await make("lead", ["lead"]);
  await make("admin", ["admin"]);
  await make("amy");
  await make("bo");
  await make("cy");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("signing up", () => {
  it("lists the camp's roles with slots and descriptions", async () => {
    const html = await (await w.fetch(get("/volunteer", cookie.amy))).text();
    for (const text of [
      "Volunteer Coordinator",
      "Camp build organizer",
      "0 of 5 filled",
      "18+ hrs during build week",
      "Sustainability Liaison",
    ]) {
      expect(html).toContain(text);
    }
    expect(await (await w.fetch(get("/", cookie.amy))).text()).toContain("Choose a job");
  });

  it("lets a member take as many roles as they like, and leave one", async () => {
    await join("amy", "Camp build organizer");
    await join("amy", "Camp decor");
    expect(await signedUp("Camp build organizer")).toEqual(["amy"]);
    const home = await (await w.fetch(get("/", cookie.amy))).text();
    expect(home).toContain("Your jobs: Camp build organizer, Camp decor");
    const r = await role("Camp decor");
    await w.fetch(
      post(
        "/volunteer",
        { intent: "leave", roleId: r.id, title: "Camp decor" },
        { cookie: cookie.amy },
      ),
    );
    expect(await signedUp("Camp decor")).toEqual([]);
    expect(await (await w.fetch(get("/volunteer", cookie.bo))).text()).toContain("Signed up: amy");
  });

  it("blocks new signups once a role is full", async () => {
    expect((await join("amy", "MOOP Lead")).status).toBe(302);
    const res = await join("bo", "MOOP Lead");
    expect(await res.text()).toContain("That job is full");
    expect(await signedUp("MOOP Lead")).toEqual(["amy"]);
    expect(await (await w.fetch(get("/volunteer", cookie.bo))).text()).toContain(">Full<");
  });

  it("lets only one of two people take a role's last slot at the same moment", async () => {
    const r = await role("Camp Cartographer");
    const viewer = (key: string): Viewer => ({
      personId: ids[key],
      authUserId: "x",
      legalName: key,
      playaName: key,
      ...asRoles([]),
    });
    const results = await Promise.allSettled([
      signUp(t.db, viewer("bo"), r.id),
      signUp(t.db, viewer("cy"), r.id),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await signedUp("Camp Cartographer")).toHaveLength(1);
  });
});

describe("managing roles (Leads)", () => {
  it("adds and removes anyone, even past a role's slots", async () => {
    const r = await role("MOOP Lead");
    await w.fetch(
      post(
        "/volunteers",
        { intent: "add_person", roleId: r.id, personId: ids.bo },
        { cookie: cookie.lead },
      ),
    );
    expect(await signedUp("MOOP Lead")).toEqual(["amy", "bo"]);
    await w.fetch(
      post(
        "/volunteers",
        { intent: "remove_person", roleId: r.id, personId: ids.amy },
        { cookie: cookie.lead },
      ),
    );
    expect(await signedUp("MOOP Lead")).toEqual(["bo"]);
  });

  it("edits, adds, retires and restores roles", async () => {
    const r = await role("Camp decor");
    await w.fetch(
      post(
        "/volunteers",
        {
          intent: "update",
          roleId: r.id,
          title: "Camp decor",
          commitment: "Lots",
          description: "Make it pretty",
          slots: "3",
          selfSignup: "1",
        },
        { cookie: cookie.lead },
      ),
    );
    expect(await role("Camp decor")).toMatchObject({ slots: 3, commitment: "Lots" });
    const bad = await w.fetch(
      post(
        "/volunteers",
        {
          intent: "update",
          roleId: r.id,
          title: "Camp decor",
          commitment: "",
          description: "",
          slots: "0",
        },
        { cookie: cookie.lead },
      ),
    );
    expect(await bad.text()).toContain("Spots must be a whole number");
    await w.fetch(
      post(
        "/volunteers",
        {
          intent: "add_role",
          title: "Kitchen captain",
          commitment: "",
          description: "Runs the kitchen",
          slots: "2",
          selfSignup: "1",
        },
        { cookie: cookie.lead },
      ),
    );
    expect(await (await w.fetch(get("/volunteer", cookie.amy))).text()).toContain(
      "Kitchen captain",
    );
    const kitchen = await role("Kitchen captain");
    await w.fetch(
      post("/volunteers", { intent: "retire", roleId: kitchen.id }, { cookie: cookie.lead }),
    );
    expect(await (await w.fetch(get("/volunteer", cookie.amy))).text()).not.toContain(
      "Kitchen captain",
    );
    await w.fetch(
      post("/volunteers", { intent: "restore", roleId: kitchen.id }, { cookie: cookie.lead }),
    );
    expect(await (await w.fetch(get("/volunteer", cookie.amy))).text()).toContain(
      "Kitchen captain",
    );
  });

  it("is Lead-only", async () => {
    expect((await w.fetch(get("/volunteers", cookie.amy))).status).toBe(403);
    const r = await role("MOOP Lead");
    const res = await w.fetch(
      post(
        "/volunteers",
        { intent: "remove_person", roleId: r.id, personId: ids.bo },
        { cookie: cookie.amy },
      ),
    );
    expect(res.status).toBe(403);
    expect(await signedUp("MOOP Lead")).toEqual(["bo"]);
  });
});

describe("elsewhere", () => {
  it("adds a Jobs column to the People export", async () => {
    const text = await (await w.fetch(get("/people/export", cookie.lead))).text();
    const rows = csvRecords(["Name"], text);
    expect(rows.find((r) => r.Name === "amy Person")?.Jobs).toBe("Camp build organizer");
  });

  it("starts signups fresh in a new season, keeping the roles", async () => {
    await w.fetch(post("/admin", { fromYear: "2027" }, { cookie: cookie.admin }));
    const html = await (await w.fetch(get("/volunteer", cookie.amy))).text();
    expect(html).toContain("2028 jobs");
    expect(html).toContain("0 of 5 filled");
    expect(html).not.toContain("Signed up:");
    await w.fetch(post("/admin", { intent: "switch", year: "2027" }, { cookie: cookie.admin }));
    expect(await (await w.fetch(get("/volunteer", cookie.amy))).text()).toContain("Signed up: amy");
    expect(
      await t.db
        .select()
        .from(volunteerSignup)
        .where(and(eq(volunteerSignup.personId, ids.amy))),
    ).not.toHaveLength(0);
  });
});
