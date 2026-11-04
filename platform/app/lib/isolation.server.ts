// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";

// Active isolation check (the "an active check proves isolation" success criterion). For every
// camp table, confirms row-level security holds for the role it connects as:
//   - with no camp set, nothing is visible;
//   - with a camp that doesn't exist, nothing is visible;
//   - with a real camp set (if given), nothing of any other camp is visible.
// It only reads. The platform's hourly health check runs it as app_platform; a daily GitHub
// Actions job runs scripts/isolation-probe.ts as app_probe; the tests run it too.

type Sql = postgres.Sql;

export async function isolationProblems(sql: Sql, campId?: string): Promise<string[]> {
  const problems: string[] = [];
  const [who] = await sql<{ bypass: boolean; superuser: boolean; user: string }[]>`
    select current_user as user, rolbypassrls as bypass, rolsuper as superuser
    from pg_roles where rolname = current_user`;
  if (who.bypass || who.superuser) {
    return [`${who.user} can skip row-level security, so this probe proves nothing`];
  }
  const tables = await sql<{ table: string }[]>`
    select c.relname as table from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'camp_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' order by 1`;
  if (tables.length === 0) return ["no camp tables found"];

  const count = (table: string, camp: string | null, onlyOthers: boolean) =>
    sql.begin(async (tx) => {
      if (camp) await tx`select set_config('app.camp_id', ${camp}, true)`;
      const where = onlyOthers ? `where camp_id is distinct from '${camp}'` : "";
      const [r] = await tx.unsafe(`select count(*)::int as n from "${table}" ${where}`);
      return r.n as number;
    });

  const sentinel = crypto.randomUUID();
  for (const { table } of tables) {
    const none = await count(table, null, false);
    if (none > 0) problems.push(`${table}: ${none} rows visible with no camp set`);
    const ghost = await count(table, sentinel, false);
    if (ghost > 0) problems.push(`${table}: ${ghost} rows visible for a camp that doesn't exist`);
    if (campId) {
      const others = await count(table, campId, true);
      if (others > 0) problems.push(`${table}: ${others} other camps' rows visible to one camp`);
    }
  }
  return problems;
}
