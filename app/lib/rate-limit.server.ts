// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import type { Db } from "./db.server";

// Fixed-window counter in the shared rate_limit table. Keys are "app:<camp>:<key>" (the camp
// from current_camp_id()), so they never collide with Better Auth's own and one camp's traffic
// can't use up another's limit. One atomic statement, so concurrent requests count correctly.
export async function hitRateLimit(
  db: Pick<Db, "execute">,
  key: string,
  { windowSeconds, max }: { windowSeconds: number; max: number },
): Promise<boolean> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const rows = await db.execute<{ count: number }>(sql`
    insert into rate_limit (id, key, count, last_request)
    values (${crypto.randomUUID()}, concat('app:', current_camp_id(), ':', ${key}::text), 1, ${now})
    on conflict (key) do update set
      count = case when ${now} - rate_limit.last_request > ${windowMs} then 1
                   else rate_limit.count + 1 end,
      last_request = case when ${now} - rate_limit.last_request > ${windowMs} then ${now}
                          else rate_limit.last_request end
    returning count
  `);
  return Number(rows[0]?.count ?? 0) <= max;
}
