// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campRole, campSettings, inquiry, memberRole, person } from "~/db/schema";
import { NO_ACCESS } from "~/lib/permissions";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #93, Phase B: custom roles and customized Lead and Treasurer, through the real Worker.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

async function member(key: string, values: Partial<typeof person.$inferInsert> = {}) {
  const p = await invitePerson(t, `${key}@example.com`, { legalName: `${key} Person`, ...values });
  ids[key] = p.id;
  cookie[key] = await signIn(w, `${key}@example.com`);
  return p;
}
async function role(name: string, grants: Partial<typeof NO_ACCESS>) {
  const [r] = await t.db
    .insert(campRole)
    .values({ name, grants: { ...NO_ACCESS, ...grants } })
    .returning();
  return r;
}
const give = (personId: string, r: { id: string }) =>
  t.db.insert(memberRole).values({ personId, role: "custom", customRoleId: r.id });

const status = async (path: string, who: string) => {
  const res = await w.fetch(get(path, cookie[who]));
  await res.body?.cancel();
  return res.status;
};
const page = async (path: string, who: string) => (await w.fetch(get(path, cookie[who]))).text();

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  await t.db.update(campSettings).set({ featureMailing: true });
  await member("admin");
  await t.db.insert(memberRole).values({ personId: ids.admin, role: "admin" });
  await member("lead");
  await t.db.insert(memberRole).values({ personId: ids.lead, role: "lead" });
  await member("coordinator");
  await give(ids.coordinator, await role("Tickets coordinator", { tickets: "manage" }));
  await member("registrar");
  await give(ids.registrar, await role("Registrar", { people: "manage", inquiries: "manage" }));
  // Someone private: hasn't shared contact details, has a mailing address and a note.
  await invitePerson(t, "private@example.com", {
    legalName: "Private Pat",
    phone: "5550001111",
    homeLocation: "Oakland",
    note2026: "PRIVATE-NOTE",
    mailingAddress: {
      line1: "1 Secret St",
      line2: null,
      city: "Oakland",
      region: null,
      postalCode: null,
      country: "United States",
    },
  }).then((p) => {
    ids.private = p.id;
  });
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("a customized Lead", () => {
  it("applies on the Lead's next request, and resetting brings back the defaults", async () => {
    expect(await status("/dues", "lead")).toBe(403);
    const [override] = await t.db
      .insert(campRole)
      .values({ builtin: "lead", grants: { ...NO_ACCESS, people: "manage", dues: "view" } })
      .returning();
    expect(await status("/dues", "lead")).toBe(200);
    // View only: no recording payments.
    const res = await w.fetch(post("/dues", { intent: "nonsense" }, { cookie: cookie.lead }));
    await res.body?.cancel();
    expect(res.status).toBe(403);
    // And the areas it no longer has.
    expect(await status("/tickets", "lead")).toBe(403);

    await t.db.delete(campRole).where(eq(campRole.id, override.id));
    expect(await status("/dues", "lead")).toBe(403);
    expect(await status("/tickets", "lead")).toBe(200);
  });
});

describe("a Tickets coordinator", () => {
  it("opens Tickets and nothing else of the Lead tools", async () => {
    expect(await status("/tickets", "coordinator")).toBe(200);
    for (const path of ["/roster", "/people", "/dues", "/announcements", "/admin"]) {
      expect(await status(path, "coordinator"), path).toBe(403);
    }
    expect(await status("/tickets/request", "coordinator")).toBe(200);
  });

  it("gets the member home with a Your tools card", async () => {
    const html = await page("/", "coordinator");
    expect(html).toContain("Your tools");
    expect(html).toContain('href="/tickets"');
    expect(html).not.toContain('href="/roster"');
  });

  it("doesn't get an archived role back by being reactivated", async () => {
    const r = await role("Seasonal", { tickets: "manage" });
    const away = await member("away");
    await give(away.id, r);
    await t.db.update(person).set({ active: false }).where(eq(person.id, away.id));
    await t.db.update(campRole).set({ archivedAt: new Date() }).where(eq(campRole.id, r.id));
    await t.db.update(person).set({ active: true }).where(eq(person.id, away.id));
    expect(await status("/tickets", "away")).toBe(403);
  });

  it("loses everything when the role is archived, even with an assignment left behind", async () => {
    const r = await role("Short-lived", { tickets: "manage" });
    const temp = await member("temp");
    await give(temp.id, r);
    expect(await status("/tickets", "temp")).toBe(200);
    await t.db.update(campRole).set({ archivedAt: new Date() }).where(eq(campRole.id, r.id));
    expect(await status("/tickets", "temp")).toBe(403);
  });
});

describe("roles held together", () => {
  it("add up: Lead plus a dues-view role sees dues and everything a Lead does", async () => {
    const both = await member("both");
    await t.db.insert(memberRole).values({ personId: both.id, role: "lead" });
    await give(both.id, await role("Dues viewer", { dues: "view" }));
    expect(await status("/dues", "both")).toBe(200);
    expect(await status("/roster", "both")).toBe(200);
  });
});

describe("the database", () => {
  it("refuses a custom assignment without its role, and a second active Lead row", async () => {
    await expect(
      t.db.insert(memberRole).values({ personId: ids.lead, role: "custom" }),
    ).rejects.toThrow();
    const [r] = await t.db.select().from(campRole).where(eq(campRole.name, "Registrar"));
    await expect(
      t.db.insert(memberRole).values({ personId: ids.lead, role: "lead", customRoleId: r.id }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(memberRole).values({ personId: ids.lead, role: "lead" }),
    ).rejects.toThrow();
  });
});

describe("a Registrar (People and Inquiries, no Private details & notes)", () => {
  it("never sees unshared contact details, mailing addresses or notes", async () => {
    const person = await page(`/people/${ids.private}`, "registrar");
    expect(person).toContain("Private Pat");
    for (const secret of [
      "5550001111",
      "Oakland",
      "PRIVATE-NOTE",
      "1 Secret St",
      "private@example.com",
    ]) {
      expect(person, secret).not.toContain(secret);
    }
    const list = await page("/people?status=all", "registrar");
    expect(list).toContain("Private Pat");
    expect(list).not.toContain("private@example.com");
    // Searching by email finds nothing either.
    expect(await page("/people?status=all&q=private%40example", "registrar")).not.toContain(
      "Private Pat",
    );
    const csv = await page("/people/export", "registrar");
    expect(csv).not.toContain("5550001111");
    expect(csv).not.toContain("PRIVATE-NOTE");
  });

  it("can save someone's name without wiping what it can't see", async () => {
    const res = await w.fetch(
      post(
        `/people/${ids.private}`,
        { intent: "update", legalName: "Private Patricia", phone: "", homeLocation: "" },
        { cookie: cookie.registrar },
      ),
    );
    expect(res.status).toBe(302);
    const [p] = await t.db.select().from(person).where(eq(person.id, ids.private));
    expect(p.legalName).toBe("Private Patricia");
    expect(p.phone).toBe("5550001111");
    expect(p.homeLocation).toBe("Oakland");
    expect(p.mailingAddress?.line1).toBe("1 Secret St");
  });

  it("can invite someone from an inquiry", async () => {
    const [inq] = await t.db
      .insert(inquiry)
      .values({ name: "Curious", email: "curious@example.com", source: "join_form" })
      .returning();
    const res = await w.fetch(
      post(`/inquiries/${inq.id}`, { intent: "invite", create: "1" }, { cookie: cookie.registrar }),
    );
    await res.body?.cancel();
    expect(res.status).toBe(302);
    expect(
      await t.db.select().from(person).where(eq(person.email, "curious@example.com")),
    ).toHaveLength(1);
  });

  it("can't reactivate a deactivated Lead, whose access is more than its own", async () => {
    const gone = await invitePerson(t, "gone@example.com", {
      legalName: "Gone Lead",
      active: false,
    });
    await t.db.insert(memberRole).values({ personId: gone.id, role: "lead" });
    const res = await w.fetch(
      post(`/people/${gone.id}`, { intent: "reactivate" }, { cookie: cookie.registrar }),
    );
    expect(await res.text()).toContain("can do things you can");
    expect((await t.db.select().from(person).where(eq(person.id, gone.id)))[0].active).toBe(false);
  });
});

describe("giving roles on a person's page", () => {
  it("is for Admins only", async () => {
    const html = await page(`/people/${ids.private}`, "lead");
    expect(html).toContain("Only Admins change roles.");
    expect(html).not.toContain("Add a role");
  });

  it("lets an Admin give a custom role, which applies on the next request", async () => {
    const [r] = await t.db.select().from(campRole).where(eq(campRole.name, "Tickets coordinator"));
    const newbie = await member("newbie");
    expect(await page(`/people/${newbie.id}`, "admin")).toContain("Tickets coordinator");
    const res = await w.fetch(
      post(
        `/people/${newbie.id}`,
        { intent: "grant", role: `custom:${r.id}` },
        { cookie: cookie.admin },
      ),
    );
    expect(res.status).toBe(302);
    expect(await status("/tickets", "newbie")).toBe(200);
    expect(await page(`/people/${newbie.id}`, "admin")).toContain("Can manage tickets");
  });

  it("asks twice before making someone an Admin", async () => {
    const res = await w.fetch(
      post(`/people/${ids.lead}`, { intent: "grant", role: "admin" }, { cookie: cookie.admin }),
    );
    expect(await res.text()).toContain("Make them an Admin");
    const admins = () =>
      t.db
        .select()
        .from(memberRole)
        .where(
          and(
            eq(memberRole.personId, ids.lead),
            eq(memberRole.role, "admin"),
            isNull(memberRole.revokedAt),
          ),
        );
    expect(await admins()).toHaveLength(0);
    const confirmed = await w.fetch(
      post(
        `/people/${ids.lead}`,
        { intent: "grant", role: "admin", confirmed: "1" },
        { cookie: cookie.admin },
      ),
    );
    expect(confirmed.status).toBe(302);
    expect(await admins()).toHaveLength(1);
  });
});

describe("who can see what", () => {
  it("lists the camp's roles that see private details and dues", async () => {
    const html = await page("/privacy-notice", "coordinator");
    expect(html).toContain("Admins and Leads can see your contact details");
    expect(html).toContain("can see whether you&#x27;ve paid dues");
    expect(html).toContain("people with the “Dues viewer” role");
    expect(html).not.toContain("people with the “Registrar” role can see your contact details");
  });
});
