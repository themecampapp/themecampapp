// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceGrants, grantProblems, type Roles } from "../../scripts/db-grants";
import { createTestDb, type TestDb } from "../helpers/db";

// Roles are cluster-wide and other test files use app_runtime at the same time, so the rules
// are checked on throwaway roles that only this file touches.
let t: TestDb;
const suffix = randomBytes(4).toString("hex");
const roles: Roles = {
  app: `t_app_${suffix}`,
  platform: `t_platform_${suffix}`,
  definer: `t_definer_${suffix}`,
  probe: `t_probe_${suffix}`,
};
const broad = `t_broad_${suffix}`;

beforeAll(async () => {
  t = await createTestDb();
  await t.client.unsafe(`create role ${roles.app} login nobypassrls`);
  await t.client.unsafe(`create role ${roles.platform} login nobypassrls`);
  await t.client.unsafe(`create role ${roles.definer} nologin bypassrls`);
  await t.client.unsafe(`create role ${roles.probe} login nobypassrls`);
  await t.client.unsafe(`create role ${broad} nologin`);
});
afterAll(async () => {
  await t.drop();
  for (const r of [...Object.values(roles), broad]) {
    await t.client.unsafe(`drop owned by ${r} cascade`).catch(() => {});
  }
  const { default: postgres } = await import("postgres");
  const admin = postgres(
    process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:54339/test",
    { max: 1, onnotice: () => {} },
  );
  for (const r of [...Object.values(roles), broad]) await admin.unsafe(`drop role if exists ${r}`);
  await admin.end();
});

const can = async (role: string, table: string, privilege: string) => {
  const [r] = await t.client<{ ok: boolean }[]>`
    select has_table_privilege(${role}, ${table}, ${privilege}) as ok`;
  return r.ok;
};

describe("database role grants", () => {
  it("applies the grants and finds nothing wrong", async () => {
    expect(await enforceGrants(t.client, roles)).toBe("enforced");
    expect(await grantProblems(t.client, roles)).toEqual([]);
    expect(await enforceGrants(t.client, roles)).toBe("enforced"); // harmless to repeat
  });

  it("makes audit_log append-only for both Workers' roles", async () => {
    await enforceGrants(t.client, roles);
    for (const role of [roles.app, roles.platform]) {
      expect(await can(role, "audit_log", "select")).toBe(true);
      expect(await can(role, "audit_log", "insert")).toBe(true);
      for (const p of ["update", "delete", "truncate"]) {
        expect(await can(role, "audit_log", p)).toBe(false);
      }
    }
  });

  it("lets the camp Worker only read camp, and the platform Worker change it", async () => {
    await enforceGrants(t.client, roles);
    expect(await can(roles.app, "camp", "select")).toBe(true);
    for (const p of ["insert", "update", "delete"]) {
      expect(await can(roles.app, "camp", p)).toBe(false);
      expect(await can(roles.platform, "camp", p)).toBe(true);
    }
    expect(await can(roles.app, "person", "update")).toBe(true);
    // Login deletion (R45) goes through login_id and forget_login: the platform gets nothing on
    // Better Auth's tables themselves.
    for (const table of ["user", "verification", "account"]) {
      for (const p of ["select", "insert", "update", "delete"]) {
        expect(await can(roles.platform, table, p), `${table} ${p}`).toBe(false);
      }
    }
  });

  it("lets the isolation probe's role read camp tables and nothing else", async () => {
    await enforceGrants(t.client, roles);
    expect(await can(roles.probe, "person", "select")).toBe(true);
    expect(await can(roles.probe, "support_grant", "select")).toBe(true);
    for (const p of ["insert", "update", "delete", "truncate"]) {
      expect(await can(roles.probe, "person", p), p).toBe(false);
    }
    for (const table of ["camp", "operator", "user", "platform_alert"]) {
      expect(await can(roles.probe, table, "select"), table).toBe(false);
    }
    await t.client.unsafe(`grant update on person to ${roles.probe}`);
    expect(await grantProblems(t.client, roles)).toContain(`${roles.probe} can change person`);
    await enforceGrants(t.client, roles);
  });

  it("lets each Worker's role call only its own cross-camp functions", async () => {
    await enforceGrants(t.client, roles);
    const callers = {
      "login_camps(text)": { app: true, platform: true },
      "email_in_use(text, text)": { app: true, platform: false },
      "suppressed_emails(text[])": { app: true, platform: false },
      "send_log_camp(text, text)": { app: false, platform: true },
      "camp_counts()": { app: false, platform: true },
      "data_requests()": { app: false, platform: true },
      "login_id(text)": { app: false, platform: true },
      "forget_login(text)": { app: false, platform: true },
      "submit_feedback(text, text, text)": { app: true, platform: false },
      "camp_usage(date)": { app: false, platform: true },
    };
    for (const [fn, expected] of Object.entries(callers)) {
      const [r] = await t.client.unsafe(
        `select has_function_privilege($1, 'public.${fn}', 'execute') as app,
                has_function_privilege($2, 'public.${fn}', 'execute') as platform`,
        [roles.app, roles.platform],
      );
      expect(r, fn).toEqual(expected);
    }
  });

  it("keeps the suppression list away from the camp Worker", async () => {
    await enforceGrants(t.client, roles);
    for (const table of [
      "email_suppression",
      "email_webhook_event",
      "operator",
      "operator_log",
      "feedback",
    ]) {
      expect(await can(roles.app, table, "select"), table).toBe(false);
      expect(await can(roles.platform, table, "select"), table).toBe(true);
    }
  });

  it("fails when a SECURITY DEFINER function is owned by a login role", async () => {
    await t.client.unsafe(
      `create function careless_definer() returns int language sql security definer
       set search_path = pg_catalog as 'select 1'`,
    );
    await t.client.unsafe(`alter function careless_definer() owner to ${roles.app}`);
    await expect(enforceGrants(t.client, roles)).rejects.toThrow(
      /careless_definer is owned by a role that can log in/,
    );
    await t.client.unsafe(`drop function careless_definer()`);
  });

  it("re-applying undoes a stray grant", async () => {
    await t.client.unsafe(`grant update, delete on audit_log to ${roles.app}`);
    expect(await enforceGrants(t.client, roles)).toBe("enforced");
    expect(await can(roles.app, "audit_log", "update")).toBe(false);
  });

  it("fails when a login role bypasses row-level security", async () => {
    await t.client.unsafe(`alter role ${roles.platform} bypassrls`);
    await expect(enforceGrants(t.client, roles)).rejects.toThrow(/bypasses row-level security/);
    await t.client.unsafe(`alter role ${roles.platform} nobypassrls`);
  });

  it("fails when a login role belongs to another role", async () => {
    await t.client.unsafe(`grant ${broad} to ${roles.app}`);
    await expect(enforceGrants(t.client, roles)).rejects.toThrow(/belongs to another role/);
    await t.client.unsafe(`revoke ${broad} from ${roles.app}`);
  });

  it("fails when the definer role can log in", async () => {
    await t.client.unsafe(`alter role ${roles.definer} login`);
    await expect(enforceGrants(t.client, roles)).rejects.toThrow(/can log in/);
    await t.client.unsafe(`alter role ${roles.definer} nologin`);
  });

  it("fails when a Worker role owns a table", async () => {
    await t.client.unsafe(`create table owned_by_app (id int)`);
    await t.client.unsafe(`alter table owned_by_app owner to ${roles.app}`);
    await expect(enforceGrants(t.client, roles)).rejects.toThrow(/owns owned_by_app/);
    await t.client.unsafe(`drop table owned_by_app`);
  });

  it("fails when a camp table is missing forced row-level security", async () => {
    await t.client.unsafe(`create table careless (id int, camp_id uuid)`);
    await expect(enforceGrants(t.client, roles)).rejects.toThrow(
      /careless lacks forced row-level security/,
    );
    await t.client.unsafe(`select enable_camp_rls('careless')`);
    expect(await enforceGrants(t.client, roles)).toBe("enforced");
    await t.client.unsafe(`drop table careless`);
  });
});
