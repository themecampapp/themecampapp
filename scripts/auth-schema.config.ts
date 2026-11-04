// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Used only by the Better Auth CLI to generate app/db/auth-schema.ts.
// Mirrors the options in app/lib/auth.server.ts that affect the schema.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const db = drizzle({ client: postgres("postgres://localhost/unused") });

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  rateLimit: { enabled: true, storage: "database" },
  // Matches app/lib/auth.server.ts. camp_id's type and foreign key are edited in by hand
  // (app/db/auth-schema.ts), since the CLI only knows "string".
  session: { additionalFields: { campId: { type: "string", required: true, input: false } } },
  plugins: [magicLink({ sendMagicLink: async () => {} })],
});
