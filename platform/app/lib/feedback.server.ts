// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { alertOperator } from "./mail.server";
import { APP_VERSION } from "../../../app/lib/version";

// In-app feedback (R65), as the operator sees it: the camp's slug, the page (ids already taken
// out by the camp app), the sender's role, the time and the words. Never who sent it. The
// feedback table is the platform's (no camp_id, no row-level security); camps only add to it.

export type FeedbackRow = {
  id: string;
  slug: string;
  path: string;
  role: string;
  message: string;
  createdAt: string;
};

export async function listFeedback(sql: postgres.Sql, limit = 200): Promise<FeedbackRow[]> {
  return sql<FeedbackRow[]>`
    select f.id, c.slug, f.path, f.role, f.message, f.created_at::text as "createdAt"
    from feedback f join camp c on c.id = f.source_camp_id
    order by f.created_at desc limit ${limit}`;
}

// Hourly: one email to the operator about feedback that hasn't been mentioned yet. It holds
// only a count and the console link, never the words (R37). Rows are marked only once the
// email has gone, so a failed send is retried next hour.
export async function notifyFeedback(sql: postgres.Sql, env: PlatformEnv): Promise<number> {
  const rows = await sql<{ id: string }[]>`select id from feedback where notified_at is null`;
  if (!rows.length) return 0;
  const n = rows.length;
  const sent = await alertOperator(
    env,
    `${n} new feedback ${n === 1 ? "message" : "messages"}`,
    `Read ${n === 1 ? "it" : "them"} in the console: https://ops.${env.PLATFORM_DOMAIN}/ops/feedback\n\n${env.PRODUCT_NAME} version ${APP_VERSION}`,
  );
  if (!sent) return 0;
  await sql`update feedback set notified_at = now() where id in ${sql(rows.map((r) => r.id))}`;
  return n;
}

// R65 retention: feedback is kept for 12 months.
export async function expireFeedback(sql: postgres.Sql): Promise<number> {
  const rows = await sql`delete from feedback where created_at < now() - interval '12 months'`;
  return rows.count;
}
