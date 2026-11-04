// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNull, sql } from "drizzle-orm";
import { auditLog, invite, memberRole, person } from "~/db/schema";
import type { Db } from "./db.server";
import { normalizeEmail } from "./email";

// One-time creation of a camp's first Lead + Treasurer. Refuses once the camp has an active
// Lead; after that, roles are granted in the app. The camp filter is explicit because the
// owner role running this script skips row-level security.
export async function bootstrapFirstLead(
  db: Db,
  input: { legalName: string; playaName?: string; email: string },
) {
  const email = normalizeEmail(input.email);
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: memberRole.id })
      .from(memberRole)
      .innerJoin(person, eq(person.id, memberRole.personId))
      .where(
        and(
          eq(memberRole.role, "lead"),
          isNull(memberRole.revokedAt),
          eq(person.active, true),
          sql`${person.campId} = current_camp_id()`,
        ),
      )
      .limit(1);
    if (existing.length > 0)
      throw new Error("An active Lead already exists; grant roles in the app.");

    const [p] = await tx
      .insert(person)
      .values({ legalName: input.legalName, playaName: input.playaName ?? null, email })
      .returning();
    await tx
      .insert(invite)
      .values({ personId: p.id, email, status: "pending", sentAt: new Date() });
    await tx.insert(memberRole).values([
      { personId: p.id, role: "lead" },
      { personId: p.id, role: "treasurer" },
    ]);
    await tx.insert(auditLog).values({
      action: "bootstrap_first_lead",
      subjectType: "person",
      subjectId: p.id,
      after: { roles: ["lead", "treasurer"], email },
    });
    return p;
  });
}
