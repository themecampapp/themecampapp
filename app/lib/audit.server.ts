// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { auditLog } from "~/db/schema";
import type { Db } from "./db.server";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AuditEntry = {
  actorPersonId: string | null;
  // Set instead of a person for what the Theme Camp App operator did (support access).
  actorOperatorId?: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  before?: unknown;
  after?: unknown;
};

// Append-only record of sensitive changes (who, when, what). Pass the transaction when the
// change is transactional so the audit row commits or rolls back with it.
export async function audit(db: Db | Tx, entry: AuditEntry) {
  const operator = entry.actorOperatorId ?? null;
  await db.insert(auditLog).values({
    actorType: operator ? "operator" : "person",
    actorPersonId: operator ? null : entry.actorPersonId,
    actorOperatorId: operator,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
