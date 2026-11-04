// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import type { Db } from "./db.server";
import { type ActivityArea, describeHistory } from "./history-labels";

// Which rows belong to an area. SAP decisions are about a person but read best with SAPs.
const AREA_SQL: Record<ActivityArea, ReturnType<typeof sql>> = {
  people: sql`a.subject_type in ('person', 'invite') and a.action not like 'sap\\_%'`,
  inquiries: sql`a.subject_type = 'inquiry'`,
  season: sql`a.subject_type in ('burn', 'email_template') and a.action not like 'sap\\_%'`,
  saps: sql`a.action like 'sap\\_%'`,
  roles: sql`a.subject_type in ('camp_position', 'volunteer_role', 'camp_role')`,
  other: sql`a.subject_type not in ('person', 'invite', 'inquiry', 'burn', 'email_template',
    'camp_position', 'volunteer_role', 'camp_role') and a.action not like 'sap\\_%'`,
};

export type ActivityRow = {
  id: string;
  at: string;
  text: string;
  actor: { id: string; name: string } | null;
  byOperator: boolean;
  // What it was about, with a link when there's a page for it.
  subject: { name: string; href: string | null } | null;
};

export async function listActivity(
  db: Db,
  opts: {
    area?: ActivityArea;
    actorId?: string;
    // Only what Theme Camp App did (support views, console actions), R40.
    operatorOnly?: boolean;
    inquiryId?: string; // just one inquiry, including the person created from it
    before?: string;
    limit: number;
  },
): Promise<{ rows: ActivityRow[]; more: boolean }> {
  const rows = await db.execute<{
    id: string;
    at: string;
    action: string;
    subject_type: string;
    subject_id: string | null;
    before: unknown;
    after: unknown;
    actor_id: string | null;
    actor_name: string | null;
    actor_type: string;
    subject_name: string | null;
    assignee: string | null;
  }>(sql`
    select a.id, to_json(a.created_at) #>> '{}' as at, a.action, a.subject_type, a.subject_id,
      a.before, a.after, a.actor_person_id as actor_id, a.actor_type,
      coalesce(ap.playa_name, ap.legal_name) as actor_name,
      case a.subject_type
        when 'person' then (select coalesce(p.playa_name, p.legal_name) from person p
          where p.id::text = a.subject_id)
        when 'inquiry' then (select i.name from inquiry i where i.id::text = a.subject_id)
        -- Issue #106: positions became jobs with the same ids.
        when 'camp_position' then (select v.title from volunteer_role v where v.id::text = a.subject_id)
        when 'volunteer_role' then (select v.title from volunteer_role v where v.id::text = a.subject_id)
        when 'burn' then (select b.year::text from burn b where b.id::text = a.subject_id)
        when 'email_template' then a.subject_id
        when 'camp_role' then (select coalesce(r.name, initcap(r.builtin)) from camp_role r
          where r.id::text = a.subject_id)
      end as subject_name,
      (select coalesce(p.playa_name, p.legal_name) from person p
        where p.id::text = a.after ->> 'assignedToPersonId') as assignee
    from audit_log a
    left join person ap on ap.id = a.actor_person_id
    where ${opts.area ? AREA_SQL[opts.area] : sql`true`}
      and (${opts.inquiryId ?? null}::text is null
        or (a.subject_type = 'inquiry' and a.subject_id = ${opts.inquiryId ?? null})
        or (a.action = 'person_created' and a.after ->> 'fromInquiry' = ${opts.inquiryId ?? null}))
      and (${opts.actorId ?? null}::uuid is null or a.actor_person_id = ${opts.actorId ?? null}::uuid)
      and (${opts.operatorOnly ?? false} = false or a.actor_type = 'operator')
      and (${opts.before ?? null}::timestamptz is null
        or a.created_at < ${opts.before ?? null}::timestamptz)
    order by a.created_at desc
    limit ${opts.limit + 1}
  `);
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    more: rows.length > opts.limit,
    rows: rows.slice(0, opts.limit).map((r) => {
      const href =
        r.subject_type === "person" && r.subject_id
          ? `/people/${r.subject_id}`
          : r.subject_type === "inquiry" && r.subject_id
            ? `/inquiries/${r.subject_id}`
            : null;
      // Only name the subject when the text doesn't already (people and inquiries).
      const showSubject =
        (r.subject_type === "person" || r.subject_type === "inquiry") && r.subject_name;
      return {
        id: r.id,
        at: r.at,
        text: describeHistory(r.action, parse(r.before), parse(r.after), {
          view: "activity",
          subject: r.subject_name,
          assignee: r.assignee,
        }),
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? "someone" } : null,
        // Done from the operator console (suspending the camp, say): no member did it.
        byOperator: r.actor_type === "operator",
        subject: showSubject ? { name: r.subject_name as string, href } : null,
      };
    }),
  };
}

// Everyone who has done something recorded, for the "who" filter.
export async function activityActors(db: Db) {
  const rows = await db.execute<{ id: string; name: string }>(sql`
    select distinct p.id, coalesce(p.playa_name, p.legal_name) as name
    from audit_log a join person p on p.id = a.actor_person_id
    order by 2
  `);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
