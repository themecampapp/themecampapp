// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { memberRole, person } from "~/db/schema";
import type { Db } from "./db.server";
import { sendMail } from "./mail.server";

type MailEnv = Parameters<typeof sendMail>[1];

// R40: every active Admin hears when support access starts and when it ends.
async function adminEmails(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ email: person.email })
    .from(person)
    .innerJoin(memberRole, and(eq(memberRole.personId, person.id), isNull(memberRole.revokedAt)))
    .where(and(eq(memberRole.role, "admin"), eq(person.active, true), isNotNull(person.email)));
  return rows.map((r) => r.email as string);
}

export async function emailSupportStarted(db: Db, env: MailEnv, expiresAt: Date) {
  const day = expiresAt.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  });
  const url = new URL("/admin/support", env.APP_URL).toString();
  for (const to of await adminEmails(db))
    await sendMail(db, env, "support_granted", to, { url, day });
}

export async function emailSupportEnded(db: Db, env: MailEnv) {
  const url = new URL("/admin/activity?who=operator", env.APP_URL).toString();
  for (const to of await adminEmails(db)) await sendMail(db, env, "support_ended", to, { url });
}
