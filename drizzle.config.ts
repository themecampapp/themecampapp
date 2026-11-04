// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "drizzle-kit";

// Migrations run from CI (and locally for tests) with the owner connection string.
// The Worker never runs migrations.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./app/db/schema.ts", "./app/db/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
});
