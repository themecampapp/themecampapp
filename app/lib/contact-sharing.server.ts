// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";

// R51 and issue #93: whether someone shares their contact details (full name, email, phone,
// home location) with the camp in the directory. Without Private details & notes, a viewer
// sees those details only for people who share them, or for themselves. One rule, used by the
// directory, the People list, the roster, the person page and the exports.

// For SQL over `person p`.
export const SHARES_CONTACT = sql`(p.directory_choice_seen_at is not null and not p.directory_hidden)`;

export const sharesContact = (p: {
  directoryChoiceSeenAt: Date | null;
  directoryHidden: boolean;
}) => p.directoryChoiceSeenAt !== null && !p.directoryHidden;
