// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  announcement,
  appSetting,
  auditLog,
  authEvent,
  burn,
  camp,
  campRole,
  campSettings,
  dues,
  emailChange,
  guide,
  inquiry,
  inquiryNote,
  invite,
  keyDate,
  leadQueueItem,
  memberRole,
  participation,
  person,
  sapPass,
  sendLog,
  ticketRequest,
  volunteerRole,
  volunteerSignup,
} from "~/db/schema";
import { sha256 } from "~/lib/support.server";
import type { TestDb } from "./db";

// A second camp ("zulu") with a row in every kind of camp data, for proving that camp A can't
// see or change any of it. Every string contains MARKER, so a leak shows up in any response
// body; the returned ids are markers too.
export const MARKER = "Zzb";
export const ZULU_SLUG = "zulu";
// A season only camp B has, so /yearbook/<year> can't resolve to camp A's own season.
export const ZULU_ONLY_YEAR = 2031;
// The plaintext of camp B's pending email-change token (stored hashed, like the app does).
// No marker in it: pages may echo a token they are given, which is not a leak.
export const ZULU_EMAIL_TOKEN = "emailchange-bravo-token";
export const ZULU_APPROVE_TOKEN = "emailchange-bravo-approve";

export type Zulu = Awaited<ReturnType<typeof seedZulu>>;

export async function seedZulu(t: TestDb) {
  const [c] = await t.db
    .insert(camp)
    .values({ slug: ZULU_SLUG, name: `${MARKER} Camp` })
    .returning();
  const campId = c.id;
  const [y2027] = await t.db.insert(burn).values({ campId, year: 2027 }).returning();
  await t.db.insert(burn).values({ campId, year: ZULU_ONLY_YEAR });
  await t.db.insert(campSettings).values({
    campId,
    currentYear: 2027,
    logoKey: `camps/${campId}/logo/00000000-0000-4000-8000-0000000000bd.webp`,
  });

  const [lead] = await t.db
    .insert(person)
    .values({
      campId,
      legalName: `${MARKER} Lead`,
      playaName: `${MARKER}lead`,
      email: "zzb-lead@example.com",
      phone: "555-0199",
      photoKey: `camps/${campId}/p/00000000-0000-4000-8000-0000000000bb.webp`,
    })
    .returning();
  const [member] = await t.db
    .insert(person)
    .values({ campId, legalName: `${MARKER} Member`, email: "zzb-member@example.com" })
    .returning();
  await t.db.insert(memberRole).values({ campId, personId: lead.id, role: "lead" });
  await t.db
    .insert(invite)
    .values({ campId, personId: member.id, email: "zzb-member@example.com", status: "pending" });

  const [pa] = await t.db
    .insert(participation)
    .values({
      campId,
      personId: member.id,
      burnId: y2027.id,
      intent: "going",
      sapRequested: true,
      sapDate: "2027-08-24",
      dwellingDescription: `${MARKER} yurt`,
    })
    .returning();
  await t.db.insert(ticketRequest).values({
    campId,
    participationId: pa.id,
    ticketsNeeded: 2,
    note: `${MARKER} ticket note`,
  });
  await t.db.insert(dues).values({ campId, participationId: pa.id, status: "unpaid" });
  const [pass] = await t.db
    .insert(sapPass)
    .values({
      campId,
      burnId: y2027.id,
      validDate: "2027-08-24",
      serial: `${MARKER}-SERIAL-1`,
      pdfKey: `camps/${campId}/sap/00000000-0000-4000-8000-0000000000bc.pdf`,
    })
    .returning();

  const [inq] = await t.db
    .insert(inquiry)
    .values({
      campId,
      name: `${MARKER} Prospect`,
      email: "zzb-prospect@example.com",
      source: "join_form",
    })
    .returning();
  await t.db
    .insert(inquiryNote)
    .values({ campId, inquiryId: inq.id, authorPersonId: lead.id, body: `${MARKER} note` });
  // A published public guide and a draft, both carrying the marker.
  const [guidePublic] = await t.db
    .insert(guide)
    .values({
      campId,
      slug: "zzb-public",
      title: `${MARKER} public guide`,
      body: `${MARKER} guide text`,
      visibility: "public",
      published: true,
    })
    .returning();
  const [guideDraft] = await t.db
    .insert(guide)
    .values({ campId, slug: "zzb-draft", title: `${MARKER} draft`, body: MARKER })
    .returning();

  const [notice] = await t.db
    .insert(announcement)
    .values({ campId, title: `${MARKER} announcement`, body: MARKER, showUntil: "2099-01-01" })
    .returning();
  const [date] = await t.db
    .insert(keyDate)
    .values({ campId, burnId: y2027.id, label: `${MARKER} date`, date: "2099-01-01" })
    .returning();

  // A data request (its link token known to the probes) and an export, both camp B's.
  const requestToken = "zzbrequesttokenzzbrequesttokenzzb1234567";
  const opRow = (
    await t.client`
    insert into operator (email, name) values ('zzb-operator@example.com', 'Zzb Operator')
    on conflict (email) do update set name = excluded.name returning id`
  )[0];
  await t.client`
    insert into data_request (camp_id, kind, requester_email, token_hash, token_expires_at, created_by_operator_id)
    values (${campId}, 'export', 'zzb-lead@example.com', ${await sha256(requestToken)},
      now() + interval '7 days', ${opRow.id})`;
  const [exp] = await t.client`
    insert into camp_export (camp_id, key, bytes, expires_at)
    values (${campId}, ${`camps/${campId}/exports/00000000-0000-4000-8000-0000000000ee.zip`}, 10,
      now() + interval '7 days') returning id`;
  // A CSV import waiting for its Lead to confirm (U17): one row, a new person.
  const [batch] = await t.client`
    insert into import_batch (camp_id, created_by_person_id, file_name, file_hash, rows)
    values (${campId}, ${lead.id}, 'zzb-people.csv', 'zzb',
      ${JSON.stringify([
        {
          line: 2,
          legalName: `${MARKER} Imported`,
          playaName: null,
          email: "zzb-imported@example.com",
          phone: null,
          homeLocation: null,
          years: [],
          flags: [],
          key: "zzbkey",
        },
      ])}::jsonb) returning id`;

  const [queueItem] = await t.db
    .insert(leadQueueItem)
    .values({ campId, kind: "no_email", personId: member.id, payload: { note: MARKER } })
    .returning();

  // Issue #106: an elected job (Leads fill it, shown in Who's who), held by the Lead.
  const [position] = await t.db
    .insert(volunteerRole)
    .values({
      campId,
      title: `${MARKER} Chair`,
      sort: 10,
      selfSignup: false,
      showInYearbook: true,
    })
    .returning();
  await t.db
    .insert(volunteerSignup)
    .values({ campId, burnId: y2027.id, roleId: position.id, personId: lead.id });
  const [role] = await t.db
    .insert(volunteerRole)
    .values({ campId, title: `${MARKER} Role`, description: `${MARKER} duties`, slots: 3 })
    .returning();
  await t.db
    .insert(volunteerSignup)
    .values({ campId, burnId: y2027.id, roleId: role.id, personId: member.id });

  // Issue #93: a custom role (held by the member) and a customized Lead.
  const [customRole] = await t.db
    .insert(campRole)
    .values({ campId, name: `${MARKER} Registrar`, grants: { people: "manage" } })
    .returning();
  await t.db
    .insert(memberRole)
    .values({ campId, personId: member.id, role: "custom", customRoleId: customRole.id });
  await t.db.insert(campRole).values({ campId, builtin: "lead", grants: { people: "view" } });

  await t.db.insert(appSetting).values({
    campId,
    key: "email_template:invite",
    value: { subject: `${MARKER} invite subject`, body: `${MARKER} body {link}` },
  });
  await t.db.insert(auditLog).values({
    campId,
    actorPersonId: lead.id,
    action: "profile_updated",
    subjectType: "person",
    subjectId: member.id,
    after: { note: MARKER },
  });
  await t.db.insert(authEvent).values({
    campId,
    event: "link_requested",
    email: "zzb-member@example.com",
    personId: member.id,
  });
  await t.db
    .insert(sendLog)
    .values({ campId, kind: "invite", recipient: "zzb-member@example.com", status: "sent" });
  await t.db.insert(emailChange).values({
    campId,
    personId: lead.id,
    newEmail: "zzb-new@example.com",
    // Approved by the current address, waiting for the new one to confirm.
    approvedAt: new Date(),
    tokenHash: createHash("sha256").update(ZULU_EMAIL_TOKEN).digest("hex"),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await t.db.insert(emailChange).values({
    campId,
    personId: member.id,
    newEmail: "zzb-approve@example.com",
    // Waiting for the current address to approve.
    approveTokenHash: createHash("sha256").update(ZULU_APPROVE_TOKEN).digest("hex"),
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  // Camp A's own records, for probes that point one of them at a camp B id (e.g. camp B's
  // person into camp A's position). Not markers: camp A may of course see them.
  const [alphaPerson] = await t.db
    .insert(person)
    .values({ campId: t.campId, legalName: "Alpha Camper", email: "alpha-camper@example.com" })
    .returning();
  const [aSeason] = await t.db.select().from(burn).where(eq(burn.campId, t.campId)).limit(1);
  const [alphaParticipation] = await t.db
    .insert(participation)
    .values({
      campId: t.campId,
      personId: alphaPerson.id,
      burnId: aSeason.id,
      intent: "going",
      sapRequested: true,
      sapDate: "2027-08-24",
    })
    .returning();
  const [alphaInquiry] = await t.db
    .insert(inquiry)
    .values({ campId: t.campId, name: "Alpha Prospect", source: "join_form" })
    .returning();
  const [alphaRole] = await t.db
    .select()
    .from(volunteerRole)
    .where(eq(volunteerRole.campId, t.campId))
    .limit(1);
  const alpha = {
    personId: alphaPerson.id,
    participationId: alphaParticipation.id,
    inquiryId: alphaInquiry.id,
    roleId: alphaRole.id,
  };

  const ids = {
    campId,
    leadId: lead.id,
    memberId: member.id,
    participationId: pa.id,
    passId: pass.id,
    inquiryId: inq.id,
    queueItemId: queueItem.id,
    guideId: guidePublic.id,
    announcementId: notice.id,
    requestToken,
    exportId: exp.id as string,
    importBatchId: batch.id as string,
    keyDateId: date.id,
    guideDraftId: guideDraft.id,
    guideSlug: guidePublic.slug,
    positionId: position.id,
    roleId: role.id,
    customRoleId: customRole.id,
    photoKey: lead.photoKey as string,
    logoName: "00000000-0000-4000-8000-0000000000bd.webp",
  };
  return { ...ids, alpha, markers: [MARKER, "zzb-", ...Object.values(ids)] };
}

// Every row camp B has, in every camp table, as one string: equal before and after means
// nothing of camp B's changed.
export async function fingerprint(t: TestDb, campId: string): Promise<string> {
  const tables = await t.client<{ table: string }[]>`
    select c.relname as table from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'camp_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' order by 1`;
  const parts: string[] = [];
  for (const { table } of tables) {
    const rows = await t.db.execute<{ j: string }>(
      sql.raw(
        `select row_to_json(x)::text as j from "${table}" x where camp_id = '${campId}' order by 1`,
      ),
    );
    parts.push(`${table}:${rows.map((r) => r.j).join("|")}`);
  }
  return parts.join("\n");
}
