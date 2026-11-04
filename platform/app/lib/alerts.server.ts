// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { alertOperator } from "./mail.server";

// Operator alerts (R55), kept in platform_alert so a problem that lasts is emailed once a day,
// not every hour. Only camps' addresses and numbers go in them, never anything anyone typed.

export type Finding = {
  key: string; // what the problem is and where, e.g. "paused:sandbox"
  subject: string; // the email subject when it's the only one
  text: string;
};

export const RESEND_AFTER_HOURS = 24;

// Emails the findings not already emailed in the last day, in one message, and records them
// once the email is accepted (so a failed email is tried again next time). With `settle`, the
// findings are everything that's wrong now: alerts no longer in them are cleared, so the same
// problem coming back later is emailed at once.
export async function raiseAlerts(
  sql: postgres.Sql,
  env: PlatformEnv,
  findings: Finding[],
  { settle = false }: { settle?: boolean } = {},
): Promise<string[]> {
  const keys = findings.map((f) => f.key);
  // "in (...)" lists, not arrays: the Worker's client doesn't fetch array types.
  if (settle) {
    if (keys.length) await sql`delete from platform_alert where key not in ${sql(keys)}`;
    else await sql`delete from platform_alert`;
  }
  if (!findings.length) return [];
  const recent = new Set(
    (
      await sql<{ key: string }[]>`
        select key from platform_alert
        where key in ${sql(keys)}
          and last_sent_at > now() - make_interval(hours => ${RESEND_AFTER_HOURS})`
    ).map((r) => r.key),
  );
  const due = findings.filter((f) => !recent.has(f.key));
  if (!due.length) return [];
  const subject =
    due.length === 1 ? due[0].subject : `${env.PRODUCT_NAME}: ${due.length} problems need a look`;
  const text = due.map((f) => f.text).join("\n\n---\n\n");
  if (!(await alertOperator(env, subject, text))) return [];
  for (const f of due) {
    await sql`
      insert into platform_alert (key, detail) values (${f.key}, ${f.text})
      on conflict (key) do update set detail = excluded.detail, last_sent_at = now()`;
  }
  return due.map((f) => f.key);
}
