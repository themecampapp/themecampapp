// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { campOrigin } from "../../../app/lib/hosts";
import { sendPlatformMail } from "../lib/mail.server";

// R39: when a support grant runs out, the camp's Admins are told it has ended, within the hour
// (without this they'd hear only when one of them next opened Admin → Support access, which
// settles it the same way: app/lib/support.server.ts settleExpired). Once per grant.
// Only active, real camps: a suspended camp and the demo camp take no writes.
export async function settleSupportGrants(sql: postgres.Sql, env: PlatformEnv): Promise<number> {
  const camps = await sql<{ id: string; slug: string; name: string }[]>`
    select id, slug, name from camp where status = 'active' and kind = 'camp'`;
  let settled = 0;
  for (const c of camps) {
    const admins = (await sql.begin(async (tx) => {
      await tx`select set_config('app.camp_id', ${c.id}, true)`;
      const ended = await tx<{ id: string }[]>`
        update support_grant set ended_notified_at = now()
        where revoked_at is null and ended_notified_at is null and expires_at <= now()
        returning id`;
      if (!ended.length) return [];
      for (const g of ended) {
        await tx`
          insert into audit_log (actor_type, action, subject_type, subject_id)
          values ('person', 'support_expired', 'support_grant', ${g.id})`;
      }
      settled += ended.length;
      const rows = await tx<{ email: string }[]>`
        select distinct lower(p.email) as email from person p
        join member_role r on r.person_id = p.id
        where r.role = 'admin' and r.revoked_at is null and p.active and p.email is not null`;
      return rows.map((r) => r.email);
    })) as string[];
    if (admins.length) {
      const link = `${campOrigin(c.slug, env.PLATFORM_DOMAIN, env)}/admin/activity?who=operator`;
      await sendPlatformMail(
        env,
        sql,
        admins,
        `${env.PRODUCT_NAME} support's access to ${c.name} has ended`,
        [
          `${env.PRODUCT_NAME} support can no longer see ${c.name}'s site.`,
          "",
          `What support looked at is listed in the camp's Activity: ${link}`,
        ].join("\n"),
      );
    }
  }
  return settled;
}
