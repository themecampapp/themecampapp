// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import type { Db } from "./db.server";
import { normalizeEmail } from "./email";

// An email may receive a sign-in link only if it has a pending invite, or it is the
// sign-in email of an active person who has already linked their login.
export async function isAllowlisted(db: Db, rawEmail: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  const rows = await db.execute<{ ok: number }>(sql`
    select 1 as ok from invite where email = ${email} and status = 'pending'
    union all
    select 1 from person p join "user" u on u.id = p.auth_user_id
      where p.active and lower(u.email) = ${email}
    limit 1
  `);
  return rows.length > 0;
}
