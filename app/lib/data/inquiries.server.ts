// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { data } from "react-router";
import { type INQUIRY_STATUSES, inquiry, inquiryNote, person, sendLog } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { normalizeEmail } from "../email";
import { personWithEmail, sendInvite } from "../invites.server";
import { sendMail } from "../mail.server";
import { atLeast } from "../permissions";
import { accessOf, heldRoles } from "../role-access.server";

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
type MailEnv = import("../mail.server").MailEnv;

const OPEN: InquiryStatus[] = ["new", "contacted", "met"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type JoinInput = {
  name: string;
  playaName: string | null;
  email: string;
  phone: string | null;
  heardFrom: string | null;
  note: string | null;
};

export function parseJoinForm(form: FormData): { input: JoinInput } | { error: string } {
  const text = (k: string, max: number) =>
    String(form.get(k) ?? "")
      .trim()
      .slice(0, max) || null;
  const name = text("name", 120);
  const email = normalizeEmail(String(form.get("email") ?? ""));
  if (!name) return { error: "Please tell us your name." };
  if (!EMAIL_RE.test(email) || email.length > 254)
    return { error: "Please enter a valid email address." };
  return {
    input: {
      name,
      playaName: text("playaName", 80),
      email,
      phone: text("phone", 40),
      heardFrom: text("heardFrom", 200),
      note: text("note", 2000),
    },
  };
}

// Records a join-page submission. A repeat from someone with an open inquiry is added to it
// rather than creating a duplicate. Emails are fixed templates: nothing typed is echoed.
// `notify`: the camp's inquiry notification list (camp settings).
export async function submitJoin(db: Db, env: MailEnv, input: JoinInput, notify: string[]) {
  const [open] = await db
    .select()
    .from(inquiry)
    .where(and(eq(inquiry.email, input.email), inArray(inquiry.status, OPEN)))
    .orderBy(desc(inquiry.receivedAt))
    .limit(1);

  let inquiryId: string;
  let isNew = false;
  if (open) {
    inquiryId = open.id;
    const body = ["Submitted the join form again.", input.note ? `Note: ${input.note}` : null]
      .filter(Boolean)
      .join(" ");
    await db.insert(inquiryNote).values({ inquiryId, body });
    await db.update(inquiry).set({ updatedAt: new Date() }).where(eq(inquiry.id, inquiryId));
  } else {
    // Someone who was declined or invited before keeps the link to their person record.
    const [previous] = await db
      .select({ personId: inquiry.personId })
      .from(inquiry)
      .where(eq(inquiry.email, input.email))
      .orderBy(desc(inquiry.receivedAt))
      .limit(1);
    const [row] = await db
      .insert(inquiry)
      .values({
        ...input,
        source: "join_form",
        status: "new",
        personId: previous?.personId ?? null,
      })
      .returning({ id: inquiry.id });
    inquiryId = row.id;
    isNew = true;
  }

  // At most one confirmation per address per day, so the form can't be used to spam someone.
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sendLog)
    .where(
      and(
        eq(sendLog.kind, "inquiry_confirmation"),
        eq(sendLog.recipient, input.email),
        gt(sendLog.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  if ((recent?.n ?? 0) === 0) {
    await sendMail(db, env, "inquiry_confirmation", input.email, { url: "" });
  }
  if (isNew) {
    const url = new URL(`/inquiries/${inquiryId}`, env.APP_URL).toString();
    for (const to of notify) await sendMail(db, env, "inquiry_notify", to, { url });
  }
  return { inquiryId, isNew };
}

export async function listInquiries(db: Db, status: InquiryStatus | "open" | "all") {
  const where =
    status === "all"
      ? undefined
      : status === "open"
        ? inArray(inquiry.status, OPEN)
        : eq(inquiry.status, status);
  const rows = await db
    .select({
      id: inquiry.id,
      name: inquiry.name,
      playaName: inquiry.playaName,
      email: inquiry.email,
      status: inquiry.status,
      source: inquiry.source,
      receivedAt: inquiry.receivedAt,
      assignedTo: sql<
        string | null
      >`(select coalesce(playa_name, legal_name) from person where id = ${inquiry.assignedToPersonId})`,
    })
    .from(inquiry)
    .where(where)
    .orderBy(desc(inquiry.receivedAt));
  const counts = await db
    .select({ status: inquiry.status, n: sql<number>`count(*)::int` })
    .from(inquiry)
    .groupBy(inquiry.status);
  return {
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>,
  };
}

export async function getInquiry(db: Db, id: string) {
  const [row] = await db.select().from(inquiry).where(eq(inquiry.id, id));
  if (!row) return null;
  const notes = await db
    .select({
      id: inquiryNote.id,
      body: inquiryNote.body,
      createdAt: inquiryNote.createdAt,
      author: sql<
        string | null
      >`(select coalesce(playa_name, legal_name) from person where id = ${inquiryNote.authorPersonId})`,
    })
    .from(inquiryNote)
    .where(eq(inquiryNote.inquiryId, id))
    .orderBy(asc(inquiryNote.createdAt));
  const matches = row.email
    ? await db
        .select({
          id: person.id,
          name: sql<string>`coalesce(${person.playaName}, ${person.legalName})`,
          active: person.active,
          signedIn: sql<boolean>`${person.authUserId} is not null`,
        })
        .from(person)
        .where(eq(person.email, row.email))
    : [];
  // Who an inquiry can be assigned to: whoever can manage inquiries (issue #93), worked out
  // from their roles here rather than in SQL, so there's one rule.
  const held = await heldRoles(db);
  const people = await db.execute<{ id: string; name: string }>(sql`
    select p.id, coalesce(p.playa_name, p.legal_name) as name from person p
    where p.active order by 2
  `);
  const leads = people.filter((p) => atLeast(accessOf(held.get(p.id)).access.inquiries, "manage"));
  return { inquiry: row, notes, matches, leads };
}

export async function addInquiryNote(db: Db, actor: Viewer, id: string, body: string) {
  assertAccess(actor, "inquiries");
  const text = body.trim().slice(0, 2000);
  if (!text) return;
  await db
    .insert(inquiryNote)
    .values({ inquiryId: id, authorPersonId: actor.personId, body: text });
  await db.update(inquiry).set({ updatedAt: new Date() }).where(eq(inquiry.id, id));
}

export async function updateInquiry(
  db: Db,
  actor: Viewer,
  id: string,
  changes: { status?: InquiryStatus; assignedToPersonId?: string | null },
) {
  assertAccess(actor, "inquiries");
  const [before] = await db.select().from(inquiry).where(eq(inquiry.id, id));
  if (!before) throw data({ reason: "not_found" }, { status: 404 });
  if (changes.status === "invited") throw data({ reason: "use_invite" }, { status: 400 });
  await db
    .update(inquiry)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(inquiry.id, id));
  await audit(db, {
    actorPersonId: actor.personId,
    action: "inquiry_updated",
    subjectType: "inquiry",
    subjectId: id,
    before: { status: before.status, assignedToPersonId: before.assignedToPersonId },
    after: changes,
  });
}

// Turns an inquiry into a member invite. `personId` links an existing person the Lead picked;
// otherwise a new person is created. Someone who is already an active, signed-in member is
// just marked invited: no second invite.
export async function inviteFromInquiry(
  db: Db,
  env: MailEnv,
  actor: Viewer,
  id: string,
  choice: { personId: string } | { create: true },
): Promise<{ personId: string; alreadyMember: boolean }> {
  // It adds a person and sends them an invite: changes in People too (issue #93).
  assertAccess(actor, "inquiries");
  assertAccess(actor, "people");
  const [inq] = await db.select().from(inquiry).where(eq(inquiry.id, id));
  if (!inq) throw data({ reason: "not_found" }, { status: 404 });
  if (!inq.email) throw data({ reason: "no_email" }, { status: 409 });

  let personId: string;
  if ("personId" in choice) {
    const [p] = await db.select().from(person).where(eq(person.id, choice.personId));
    if (!p) throw data({ reason: "not_found" }, { status: 404 });
    personId = p.id;
  } else {
    if ((await personWithEmail(db, inq.email))?.active) {
      throw data({ reason: "email_in_use" }, { status: 409 });
    }
    const [p] = await db
      .insert(person)
      .values({ legalName: inq.name, playaName: inq.playaName, email: inq.email, phone: inq.phone })
      .returning();
    personId = p.id;
    await audit(db, {
      actorPersonId: actor.personId,
      action: "person_created",
      subjectType: "person",
      subjectId: p.id,
      after: { fromInquiry: id },
    });
  }

  const [p] = await db.select().from(person).where(eq(person.id, personId));
  const alreadyMember = !!p.authUserId && p.active;
  if (!alreadyMember) await sendInvite(db, env, actor, personId);

  await db
    .update(inquiry)
    .set({ status: "invited", personId, updatedAt: new Date() })
    .where(eq(inquiry.id, id));
  await audit(db, {
    actorPersonId: actor.personId,
    action: "inquiry_invited",
    subjectType: "inquiry",
    subjectId: id,
    after: { personId, alreadyMember },
  });
  return { personId, alreadyMember };
}

export async function openInquiryCount(db: Db) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inquiry)
    .where(and(eq(inquiry.status, "new")));
  return row?.n ?? 0;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function closeExisting(
  tx: Tx,
  actor: Viewer,
  inquiryId: string,
  personId: string,
  name: string,
) {
  await tx
    .update(inquiry)
    .set({ status: "invited", personId, updatedAt: new Date() })
    .where(eq(inquiry.id, inquiryId));
  await tx.insert(inquiryNote).values({
    inquiryId,
    authorPersonId: actor.personId,
    body: `Closed as an existing camper (linked to ${name}). No email was sent.`,
  });
  await audit(tx, {
    actorPersonId: actor.personId,
    action: "inquiry_closed_existing",
    subjectType: "inquiry",
    subjectId: inquiryId,
    after: { personId, emailed: false },
  });
}

// For inquiries from people who already camped with us: link to their person record and
// close the inquiry WITHOUT sending anything. They're invited later through the normal
// returning-camper flow.
export async function closeAsExistingCamper(
  db: Db,
  actor: Viewer,
  inquiryId: string,
  personId: string,
) {
  assertAccess(actor, "inquiries");
  const [p] = await db.select().from(person).where(eq(person.id, personId));
  if (!p) throw data({ reason: "not_found" }, { status: 404 });
  const [inq] = await db.select().from(inquiry).where(eq(inquiry.id, inquiryId));
  if (!inq) throw data({ reason: "not_found" }, { status: 404 });
  if (!OPEN.includes(inq.status)) return;
  await db.transaction((tx) =>
    closeExisting(tx, actor, inquiryId, p.id, p.playaName ?? p.legalName),
  );
}

// Open imported inquiries that clearly belong to one existing person: linked at import, or
// the email matches exactly one active person.
export async function matchedImportedInquiries(db: Db) {
  const rows = await db.execute<{
    id: string;
    name: string;
    person_id: string;
    person_name: string;
  }>(sql`
    select i.id, i.name, coalesce(i.person_id, m.id) as person_id,
      coalesce(lp.playa_name, lp.legal_name, m.playa_name, m.legal_name) as person_name
    from inquiry i
    left join person lp on lp.id = i.person_id
    left join lateral (
      select p.id, p.playa_name, p.legal_name from person p
      where i.person_id is null and i.email is not null and p.email = i.email and p.active
      and (select count(*) from person q where q.email = i.email and q.active) = 1
    ) m on true
    where i.source = 'import' and i.status in ('new', 'contacted', 'met')
      and coalesce(i.person_id, m.id) is not null
    order by i.name
  `);
  return [...rows];
}

export async function closeMatchedImportedInquiries(db: Db, actor: Viewer) {
  assertAccess(actor, "inquiries");
  const matched = await matchedImportedInquiries(db);
  await db.transaction(async (tx) => {
    for (const m of matched) await closeExisting(tx, actor, m.id, m.person_id, m.person_name);
  });
  return matched.length;
}
