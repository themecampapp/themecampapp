// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, campRole, campSettings, memberRole } from "~/db/schema";
import { MAX_CUSTOM_ROLES, NO_ACCESS } from "~/lib/permissions";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Issue #93: Admin → Roles, through the real Worker.

let t: TestDb;
let w: TestWorker;
const cookie: Record<string, string> = {};
const ids: Record<string, string> = {};

// Every area's level as the editor posts it.
const levels = (grants: Partial<typeof NO_ACCESS>) =>
  Object.fromEntries(
    Object.entries({ ...NO_ACCESS, ...grants }).map(([k, v]) => [`level_${k}`, v]),
  ) as Record<string, string>;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  for (const [key, role] of [
    ["admin", "admin"],
    ["lead", "lead"],
    ["lead2", "lead"],
  ] as const) {
    const p = await invitePerson(t, `${key}@example.com`, { legalName: `${key} Person` });
    ids[key] = p.id;
    await t.db.insert(memberRole).values({ personId: p.id, role });
    cookie[key] = await signIn(w, `${key}@example.com`);
  }
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const send = (path: string, fields: Record<string, string>, who = "admin") =>
  w.fetch(post(path, fields, { cookie: cookie[who] }));
const html = async (path: string, who = "admin") => (await w.fetch(get(path, cookie[who]))).text();

describe("the roles list", () => {
  it("shows Member, Lead, Treasurer and Admin, with who holds each", async () => {
    const page = await html("/admin/roles");
    for (const text of [
      "Member",
      "Lead",
      "Treasurer",
      "Admin",
      "lead Person",
      "Can manage people",
    ]) {
      expect(page, text).toContain(text);
    }
  });

  it("is Admins only", async () => {
    for (const path of ["/admin/roles", "/admin/roles/new", "/admin/roles/lead"]) {
      const res = await w.fetch(get(path, cookie.lead));
      await res.body?.cancel();
      expect(res.status, path).toBe(403);
    }
    const res = await send("/admin/roles/lead", { intent: "save", ...levels({}) }, "lead");
    await res.body?.cancel();
    expect(res.status).toBe(403);
    expect(await t.db.select().from(campRole)).toEqual([]);
  });
});

describe("editing Lead", () => {
  it("warns before taking something away from the Leads, then saves and audits", async () => {
    const lower = { intent: "save", ...levels({ people: "view", private: "view", dues: "view" }) };
    const first = await (await send("/admin/roles/lead", lower)).text();
    expect(first).toContain("This takes away");
    expect(first).toContain("lead Person");
    expect(await t.db.select().from(campRole)).toEqual([]);

    const saved = await send("/admin/roles/lead", { ...lower, confirmed: "1" });
    expect(saved.status).toBe(302);
    const [row] = await t.db.select().from(campRole).where(eq(campRole.builtin, "lead"));
    expect(row.grants).toMatchObject({ people: "view", dues: "view", tickets: "none" });
    // It also counts as reviewing the roles (the setup checklist's item).
    const [settings] = await t.db.select().from(campSettings);
    expect(settings.rolesReviewedAt).not.toBeNull();
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, "role_updated"));
    expect(entry.before).toMatchObject({ grants: { people: "manage", dues: "none" } });
    expect(entry.after).toMatchObject({ grants: { people: "view", dues: "view" } });
    expect(await html("/admin/roles")).toContain("Customized");
  });

  it("says what resetting would take away", async () => {
    await t.db
      .update(campRole)
      .set({ grants: { ...NO_ACCESS, people: "manage", private: "view", dues: "manage" } })
      .where(eq(campRole.builtin, "lead"));
    expect(await html("/admin/roles/lead")).toContain("This takes away Dues from");
  });

  it("goes back to the defaults on reset", async () => {
    const res = await send("/admin/roles/lead", { intent: "reset" });
    expect(res.status).toBe(302);
    expect(await t.db.select().from(campRole).where(eq(campRole.builtin, "lead"))).toEqual([]);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "role_reset")),
    ).toHaveLength(1);
    expect(await html("/admin/roles")).not.toContain("Customized");
  });
});

describe("custom roles", () => {
  it("are created from a starting point, with the editor's levels", async () => {
    expect(await html("/admin/roles/new?start=registrar")).toContain("Registrar");
    const res = await send("/admin/roles/new", {
      name: "Registrar",
      description: "Handles new people",
      ...levels({ people: "manage", inquiries: "manage" }),
    });
    expect(res.status).toBe(302);
    const [row] = await t.db.select().from(campRole).where(eq(campRole.name, "Registrar"));
    expect(row.grants).toMatchObject({ people: "manage", inquiries: "manage", private: "none" });
    expect(await html("/admin/roles")).toContain("Can manage people and inquiries");
  });

  it("refuse a built-in role's name, a duplicate name, and an unknown level", async () => {
    for (const [name, message] of [
      ["lead", "already roles"],
      ["REGISTRAR", "already a role with that name"],
    ]) {
      const page = await (await send("/admin/roles/new", { name, ...levels({}) })).text();
      expect(page, name).toContain(message);
    }
    await send("/admin/roles/new", {
      name: "Odd",
      level_people: "owner",
      level_nonsense: "manage",
    });
    const [odd] = await t.db.select().from(campRole).where(eq(campRole.name, "Odd"));
    expect(odd.grants).toMatchObject({ people: "none" });
    expect(odd.grants).not.toHaveProperty("nonsense");
  });

  it("stop at the most a camp can have", async () => {
    const [{ n }] = await t.client<{ n: number }[]>`
      select count(*)::int as n from camp_role where builtin is null and archived_at is null`;
    for (let i = n; i < MAX_CUSTOM_ROLES; i++) {
      await t.db.insert(campRole).values({ name: `Filler ${i}`, grants: NO_ACCESS });
    }
    const page = await (
      await send("/admin/roles/new", { name: "One too many", ...levels({}) })
    ).text();
    expect(page).toContain("up to 20 custom roles");
    await t.client`delete from camp_role where name like 'Filler %'`;
  });

  it("take the role away from everyone who holds it when archived", async () => {
    const [r] = await t.db.select().from(campRole).where(eq(campRole.name, "Registrar"));
    for (const p of [ids.lead, ids.lead2]) {
      await t.db.insert(memberRole).values({ personId: p, role: "custom", customRoleId: r.id });
    }
    const res = await send(`/admin/roles/${r.id}`, { intent: "archive" });
    expect(res.status).toBe(302);
    const active = await t.db
      .select()
      .from(memberRole)
      .where(and(eq(memberRole.customRoleId, r.id), isNull(memberRole.revokedAt)));
    expect(active).toEqual([]);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "role_revoked")),
    ).toHaveLength(2);
    const list = await html("/admin/roles");
    expect(list).toContain("Archived roles (1)");
    // Its page is gone, and its name can be used again.
    const gone = await w.fetch(get(`/admin/roles/${r.id}`, cookie.admin));
    await gone.body?.cancel();
    expect(gone.status).toBe(404);
    const again = await send("/admin/roles/new", { name: "Registrar", ...levels({}) });
    expect(again.status).toBe(302);
  });

  it("can't be given once archived", async () => {
    const [archived] = await t.db
      .select()
      .from(campRole)
      .where(and(eq(campRole.name, "Registrar"), isNotNull(campRole.archivedAt)));
    const res = await send(`/people/${ids.lead}`, {
      intent: "grant",
      role: `custom:${archived.id}`,
    });
    expect(await res.text()).toContain("archived");
  });

  it("round a level an area doesn't offer down", async () => {
    await send("/admin/roles/new", { name: "Rounder", ...levels({}), level_private: "manage" });
    const [row] = await t.db.select().from(campRole).where(eq(campRole.name, "Rounder"));
    expect(row.grants).toMatchObject({ private: "view" });
  });
});

describe("Admin → Roles changes made at the same moment", () => {
  it("never go past the cap, however many arrive together", async () => {
    const [{ n }] = await t.client<{ n: number }[]>`
      select count(*)::int as n from camp_role where builtin is null and archived_at is null`;
    for (let i = n; i < MAX_CUSTOM_ROLES - 1; i++) {
      await t.db.insert(campRole).values({ name: `Filler ${i}`, grants: NO_ACCESS });
    }
    const results = await Promise.all(
      [1, 2, 3].map((i) => send("/admin/roles/new", { name: `Racer ${i}`, ...levels({}) })),
    );
    expect(results.filter((r) => r.status === 302)).toHaveLength(1);
    const [{ total }] = await t.client<{ total: number }[]>`
      select count(*)::int as total from camp_role where builtin is null and archived_at is null`;
    expect(total).toBe(MAX_CUSTOM_ROLES);
    await t.client`delete from camp_role where name like 'Filler %' or name like 'Racer %'`;
  });

  it("save a first customized Treasurer once, without a misleading name error", async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        send("/admin/roles/treasurer", {
          intent: "save",
          confirmed: "1",
          ...levels({ dues: "manage", roster: "view" }),
        }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe(302);
      await r.body?.cancel();
    }
    expect(
      await t.db.select().from(campRole).where(eq(campRole.builtin, "treasurer")),
    ).toHaveLength(1);
    await send("/admin/roles/treasurer", { intent: "reset" });
  });
});

describe("non-Admins on Admin → Roles", () => {
  it("can't archive or reset a role by posting directly", async () => {
    const [r] = await t.db
      .insert(campRole)
      .values({ name: "Untouchable", grants: { ...NO_ACCESS, tickets: "manage" } })
      .returning();
    await t.db
      .insert(campRole)
      .values({ builtin: "lead", grants: { ...NO_ACCESS, people: "view" } });
    for (const [path, intent] of [
      [`/admin/roles/${r.id}`, "archive"],
      ["/admin/roles/lead", "reset"],
    ]) {
      const res = await send(path, { intent }, "lead");
      await res.body?.cancel();
      expect(res.status, intent).toBe(403);
    }
    const [still] = await t.db.select().from(campRole).where(eq(campRole.id, r.id));
    expect(still.archivedAt).toBeNull();
    expect(await t.db.select().from(campRole).where(eq(campRole.builtin, "lead"))).toHaveLength(1);
    await t.client`delete from camp_role where builtin = 'lead'`;
  });
});
