// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { dataRequest } from "~/db/schema";
import { audit } from "./audit.server";
import type { Db } from "./db.server";
import { sha256 } from "./support.server";

// The camp side of a data request (R45a): the requester opens the emailed link on the camp's
// site and presses the button. Viewing the page (a GET, as a mail scanner would) confirms
// nothing. The lookup runs under this camp's row-level security, so a link only works on its
// own camp's site.

export type RequestKind = "export" | "delete_camp" | "delete_login";

async function find(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [r] = await db
    .select({
      id: dataRequest.id,
      kind: dataRequest.kind,
      email: dataRequest.requesterEmail,
      confirmedAt: dataRequest.confirmedAt,
      expired: sql<boolean>`${dataRequest.tokenExpiresAt} <= now()`,
    })
    .from(dataRequest)
    .where(eq(dataRequest.tokenHash, await sha256(token)));
  return r ?? null;
}

export async function viewRequest(db: Db, token: string) {
  const r = await find(db, token);
  if (!r || r.expired) return { state: "invalid" as const };
  return {
    state: r.confirmedAt ? ("confirmed" as const) : ("pending" as const),
    kind: r.kind as RequestKind,
    email: r.email,
  };
}

export async function confirmRequest(db: Db, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return false;
  const tokenHash = await sha256(token);
  return db.transaction(async (tx) => {
    const [r] = await tx
      .update(dataRequest)
      .set({ confirmedAt: new Date() })
      .where(
        and(
          eq(dataRequest.tokenHash, tokenHash),
          isNull(dataRequest.confirmedAt),
          gt(dataRequest.tokenExpiresAt, sql`now()`),
        ),
      )
      .returning({ id: dataRequest.id, kind: dataRequest.kind });
    if (!r) return false;
    await audit(tx, {
      actorPersonId: null,
      action: "data_request_confirmed",
      subjectType: "data_request",
      subjectId: r.id,
      after: { kind: r.kind },
    });
    return true;
  });
}
