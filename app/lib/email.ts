// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Emails are compared trimmed and lowercased everywhere (the original is kept on import).
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
