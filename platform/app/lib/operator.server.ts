// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import type { Operator } from "./context.server";

// The active operator an Access-verified email belongs to, or null (R41). Operators are added
// with scripts/add-operator.ts; there is no sign-up.
export async function operatorFor(sql: postgres.Sql, email: string): Promise<Operator | null> {
  const [row] = await sql<Operator[]>`
    select id, email, name from operator where email = ${email.toLowerCase()} and active`;
  return row ?? null;
}
