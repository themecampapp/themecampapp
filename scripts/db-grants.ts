// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The database roles' privileges, in one place. Runs after migrations on every deploy (with the
// owner connection): it re-applies the grants below, then fails the deploy if anything about
// the roles or row-level security isn't as it must be. Tests apply it to every test database.
//   DATABASE_URL=<owner> npm run db:grants
//
//   app_runtime   camp Worker: DML on camp tables (under RLS), read-only on camp, Better Auth's
//                 tables. audit_log is read and insert only.
//   app_platform  platform Worker: DML on camp tables (under RLS, with a camp set) and on camp.
//                 audit_log is read and insert only.
//   app_definer   NOLOGIN, BYPASSRLS: owns the few SECURITY DEFINER functions that read across
//                 camps. Read-only on tables unless a function needs more.
//   app_probe     the daily isolation probe (.github/workflows/isolation-probe.yml): reads camp
//                 tables under RLS, nothing else. Optional; checked only where it exists.
// Roles are created with SQL by scripts/db-roles.ts, never in the Neon console (console roles
// join neon_superuser, which bypasses row-level security).
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export const APP_ROLE = "app_runtime";
export const PLATFORM_ROLE = "app_platform";
export const DEFINER_ROLE = "app_definer";
export const PROBE_ROLE = "app_probe";

// The role names, overridable so tests can check the rules on throwaway roles without touching
// the real ones (roles are cluster-wide, and other test files use app_runtime concurrently).
export type Roles = { app: string; platform: string; definer: string; probe: string };
export const ROLES: Roles = {
  app: APP_ROLE,
  platform: PLATFORM_ROLE,
  definer: DEFINER_ROLE,
  probe: PROBE_ROLE,
};

// SECURITY DEFINER functions the camp Worker may call (drizzle/0005, 0007).
export const CAMP_DEFINER_FUNCTIONS = [
  "public.login_camps(text)",
  "public.email_in_use(text, text)",
  "public.suppressed_emails(text[])",
  // R65: add feedback for the request's own camp; the camp gets nothing else on that table.
  "public.submit_feedback(text, text, text)",
] as const;

// ...and the platform Worker (drizzle/0007).
export const PLATFORM_DEFINER_FUNCTIONS = [
  "public.send_log_camp(text, text)",
  "public.camp_counts()",
  "public.data_requests()",
  // R74: usage numbers per camp per day (drizzle/0021).
  "public.camp_usage(date)",
  // Login deletion (R45): find the login by email and every camp it has a person in, then
  // remove it with its pending magic links. Never Better Auth's tables themselves.
  "public.login_camps(text)",
  "public.login_id(text)",
  "public.forget_login(text)",
] as const;

// Platform-wide tables only the platform Worker writes (no camp_id, so no row-level security).
// The camp Worker gets nothing on them.
export const PLATFORM_TABLES = {
  email_suppression: "select, insert, update",
  email_webhook_event: "select, insert",
  // Operators are added by scripts/add-operator.ts with the owner connection; the console
  // only reads them. The operator log is append-only, like the audit log.
  operator: "select",
  operator_log: "select, insert",
  // The hourly health check's record of what it has emailed (U14).
  platform_alert: "select, insert, update, delete",
  // In-app feedback (R65): the console reads it, the hourly job marks it emailed and removes
  // it after 12 months. Camps add to it only through submit_feedback().
  feedback: "select, update, delete",
  // Sign-up requests (issue #73): the public page adds them, the console decides them, and
  // the hourly job removes them 90 days after the decision.
  camp_signup: "select, insert, update, delete",
} as const;

// What app_definer may change beyond reading: forget_login deletes a login (sessions and
// accounts cascade) and its pending magic links; submit_feedback adds feedback.
export const DEFINER_WRITES = {
  user: "delete",
  verification: "delete",
  // submit_feedback() adds feedback for the request's camp.
  feedback: "insert",
} as const;

export const AUTH_TABLES = ["user", "session", "account", "verification", "rate_limit"] as const;

const DML = "select, insert, update, delete";

// Every table in public with a camp_id column: the camp-owned tables.
export async function campTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table: string }[]>`
    select c.relname as table from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'camp_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
    order by 1`;
  return rows.map((r) => r.table);
}

const quote = (table: string) => `"${table.replaceAll('"', '""')}"`;

async function applyGrants(sql: Sql, tables: string[], roles: Roles) {
  for (const role of [roles.app, roles.platform]) {
    await sql.unsafe(`revoke all on all tables in schema public from ${role}`);
    await sql.unsafe(`grant usage on schema public to ${role}`);
    for (const t of tables) {
      await sql.unsafe(
        t === "audit_log"
          ? `grant select, insert on ${quote(t)} to ${role}`
          : `grant ${DML} on ${quote(t)} to ${role}`,
      );
    }
  }
  // Each function's callers, together: a function both Workers call (login_camps) is revoked
  // once and then granted to each, never revoked again by the second pass.
  const callers = new Map<string, string[]>();
  for (const fn of CAMP_DEFINER_FUNCTIONS) callers.set(fn, [...(callers.get(fn) ?? []), roles.app]);
  for (const fn of PLATFORM_DEFINER_FUNCTIONS) {
    callers.set(fn, [...(callers.get(fn) ?? []), roles.platform]);
  }
  for (const [fn, granted] of callers) {
    // Only a function's owner (app_definer) may change who can call it. The migration owner
    // may SET ROLE to it (scripts/db-roles.ts), for this transaction only.
    const [{ owner }] = await sql<{ owner: string }[]>`
      select pg_get_userbyid(proowner) as owner from pg_proc where oid = ${fn}::regprocedure`;
    await sql.unsafe(`set local role ${owner}`);
    await sql.unsafe(`revoke all on function ${fn} from public, ${roles.app}, ${roles.platform}`);
    for (const role of granted) await sql.unsafe(`grant execute on function ${fn} to ${role}`);
    await sql.unsafe("reset role");
  }
  for (const [table, privileges] of Object.entries(PLATFORM_TABLES)) {
    await sql.unsafe(`grant ${privileges} on ${quote(table)} to ${roles.platform}`);
  }
  await sql.unsafe(`grant select on camp to ${roles.app}`);
  await sql.unsafe(`grant ${DML} on camp to ${roles.platform}`);
  for (const t of AUTH_TABLES) await sql.unsafe(`grant ${DML} on ${quote(t)} to ${roles.app}`);

  const [probe] = await sql`select 1 from pg_roles where rolname = ${roles.probe}`;
  if (probe) {
    await sql.unsafe(`revoke all on all tables in schema public from ${roles.probe}`);
    await sql.unsafe(`grant usage on schema public to ${roles.probe}`);
    for (const t of tables) await sql.unsafe(`grant select on ${quote(t)} to ${roles.probe}`);
  }

  const [definer] = await sql`select 1 from pg_roles where rolname = ${roles.definer}`;
  if (definer) {
    await sql.unsafe(`revoke all on all tables in schema public from ${roles.definer}`);
    await sql.unsafe(`grant usage on schema public to ${roles.definer}`);
    await sql.unsafe(`grant select on all tables in schema public to ${roles.definer}`);
    for (const [table, privileges] of Object.entries(DEFINER_WRITES)) {
      await sql.unsafe(`grant ${privileges} on ${quote(table)} to ${roles.definer}`);
    }
  }
}

// Everything that must hold. Returns the problems found (empty when all is well).
export async function grantProblems(sql: Sql, roles: Roles = ROLES): Promise<string[]> {
  const problems: string[] = [];
  const loginRoles = [roles.app, roles.platform];
  const [probe] = await sql`select 1 from pg_roles where rolname = ${roles.probe}`;
  if (probe) loginRoles.push(roles.probe);

  const names = [...loginRoles, roles.definer];
  const found = await sql<
    {
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
      memberships: number;
    }[]
  >`
    select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
      (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships
    from pg_roles r where r.rolname in ${sql(names)}`;
  for (const r of found) {
    if (r.rolname === roles.definer) {
      if (r.rolcanlogin) problems.push(`${r.rolname} can log in`);
      if (r.rolsuper) problems.push(`${r.rolname} is a superuser`);
      continue;
    }
    if (r.rolsuper) problems.push(`${r.rolname} is a superuser`);
    if (r.rolbypassrls) problems.push(`${r.rolname} bypasses row-level security`);
    if (r.rolcreaterole || r.rolcreatedb)
      problems.push(`${r.rolname} can create roles or databases`);
    if (r.memberships > 0) problems.push(`${r.rolname} belongs to another role`);
  }

  const owned = await sql<{ role: string; object: string }[]>`
    select pg_get_userbyid(c.relowner) as role, c.relname as object from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and pg_get_userbyid(c.relowner) in ${sql(loginRoles)}
    union all
    select pg_get_userbyid(p.proowner), p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and pg_get_userbyid(p.proowner) in ${sql(loginRoles)}`;
  for (const o of owned) problems.push(`${o.role} owns ${o.object}`);

  const present = found.filter((r) => loginRoles.includes(r.rolname)).map((r) => r.rolname);
  for (const role of present) {
    const [w] = await sql<{ canWrite: boolean }[]>`
      select has_table_privilege(${role}, 'audit_log', 'update')
        or has_table_privilege(${role}, 'audit_log', 'delete')
        or has_table_privilege(${role}, 'audit_log', 'truncate') as "canWrite"`;
    if (w.canWrite) problems.push(`${role} can change audit_log`);
  }
  if (probe) {
    const writable = await sql<{ table: string }[]>`
      select c.relname as table from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (has_table_privilege(${roles.probe}, c.oid, 'insert')
          or has_table_privilege(${roles.probe}, c.oid, 'update')
          or has_table_privilege(${roles.probe}, c.oid, 'delete')
          or has_table_privilege(${roles.probe}, c.oid, 'truncate'))`;
    for (const w of writable) problems.push(`${roles.probe} can change ${w.table}`);
  }
  if (present.includes(roles.app)) {
    const [c] = await sql<{ canWrite: boolean }[]>`
      select has_table_privilege(${roles.app}, 'camp', 'insert')
        or has_table_privilege(${roles.app}, 'camp', 'update')
        or has_table_privilege(${roles.app}, 'camp', 'delete') as "canWrite"`;
    if (c.canWrite) problems.push(`${roles.app} can change camp`);
  }

  // Functions that skip row-level security must be owned by a role that can't log in and must
  // pin their search_path, so nobody can swap in their own tables.
  const definers = await sql<{ fn: string; canLogin: boolean; pinned: boolean }[]>`
    select p.proname as fn, r.rolcanlogin or r.rolsuper as "canLogin",
      coalesce(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'), false)
        as pinned
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and p.prosecdef`;
  for (const d of definers) {
    if (d.canLogin) problems.push(`SECURITY DEFINER ${d.fn} is owned by a role that can log in`);
    if (!d.pinned) problems.push(`SECURITY DEFINER ${d.fn} doesn't pin its search_path`);
  }

  const rls = await sql<{ table: string; enabled: boolean; forced: boolean; policy: boolean }[]>`
    select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
      exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'camp_isolation')
        as policy
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'camp_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'`;
  for (const r of rls) {
    if (!r.enabled || !r.forced || !r.policy) {
      problems.push(`${r.table} lacks forced row-level security (run enable_camp_rls)`);
    }
  }
  return problems;
}

export async function enforceGrants(
  sql: Sql,
  roles: Roles = ROLES,
): Promise<"enforced" | "no_role"> {
  const [role] = await sql`select 1 from pg_roles where rolname = ${roles.app}`;
  if (!role) return "no_role";
  const [platform] = await sql`select 1 from pg_roles where rolname = ${roles.platform}`;
  if (!platform) throw new Error(`${roles.platform} is missing: run scripts/db-roles.ts`);
  // One transaction: a failure part-way leaves the previous grants in place.
  await sql.begin(async (tx) => {
    await applyGrants(tx as unknown as Sql, await campTables(tx as unknown as Sql), roles);
  });
  const problems = await grantProblems(sql, roles);
  if (problems.length) throw new Error(`database roles are wrong: ${problems.join("; ")}`);
  return "enforced";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL (owner) is required");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const result = await enforceGrants(sql);
    console.log(
      result === "enforced"
        ? "grants applied; roles and row-level security check out"
        : `no ${APP_ROLE} role here; nothing to do`,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
