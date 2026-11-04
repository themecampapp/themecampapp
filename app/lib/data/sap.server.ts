// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, participation, person, sapPass, sapReview } from "~/db/schema";
import { assertAccess, can, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { newKey } from "../files.server";
import { sendMail } from "../mail.server";
import { currentSeason } from "./participation.server";
import { releasePassesOf } from "./sap-cascade.server";

// Setup Access Passes (SAPs). Campers request one on their RSVP (with a day). Admins stock the
// passes Burning Man allocates (date, serial number, the PDF to print). Leads approve or deny
// requests and assign a specific pass. The camper downloads their pass's PDF from home.

type Env = { PHOTOS: R2Bucket } & import("../mail.server").MailEnv;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const MAX_PDF_BYTES = 5 * 1024 * 1024;
const refuse = (reason: string, status = 400) => data({ reason }, { status });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
const coming = (intent: string | null) => intent === "going" || intent === "leaning_yes";

function assertLead(actor: Viewer) {
  assertAccess(actor, "saps");
}
function assertAdmin(actor: Viewer) {
  if (!actor.isAdmin) throw refuse("admin_only", 403);
}

export const formatSapDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

// ─── SAP days (Admins) ─────────────────────────────────────────────────────────────────────

// The days campers can pick this season, in order. Empty until an Admin sets them.
export async function getSapDays(db: Db): Promise<string[]> {
  const season = await currentSeason(db);
  return [...(season.sapDays ?? [])].sort();
}

export const sapDayOptions = (days: string[]) =>
  days.map((value) => ({ value, label: formatSapDay(value) }));

export async function setSapDays(db: Db, actor: Viewer, input: string[]) {
  assertAdmin(actor);
  const days = [...new Set(input.map((d) => d.trim()).filter(Boolean))].sort();
  if (days.some((d) => !isDate(d))) throw refuse("sap_date_needed");
  if (days.length > 21) throw refuse("sap_too_many_days");
  const season = await currentSeason(db);
  await db.transaction(async (tx) => {
    await tx.update(burn).set({ sapDays: days }).where(eq(burn.id, season.id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "sap_days_set",
      subjectType: "burn",
      subjectId: season.id,
      before: { days: season.sapDays },
      after: { days },
    });
  });
}

// ─── Stock (Admins) ────────────────────────────────────────────────────────────────────────

export type PassRow = {
  id: string;
  validDate: string;
  serial: string;
  hasPdf: boolean;
  holderName: string | null;
  holderPersonId: string | null;
};

export async function listPasses(db: Db): Promise<PassRow[]> {
  const season = await currentSeason(db);
  const rows = await db.execute<{
    id: string;
    valid_date: string;
    serial: string;
    has_pdf: boolean;
    holder_name: string | null;
    holder_person_id: string | null;
  }>(sql`
    select s.id, s.valid_date::text as valid_date, s.serial, s.pdf_key is not null as has_pdf,
      coalesce(p.playa_name, p.legal_name) as holder_name, p.id as holder_person_id
    from sap_pass s
    left join participation pa on pa.id = s.holder_participation_id
    left join person p on p.id = pa.person_id
    where s.burn_id = ${season.id}
    order by s.valid_date, s.serial
  `);
  return rows.map((r) => ({
    id: r.id,
    validDate: r.valid_date,
    serial: r.serial,
    hasPdf: r.has_pdf,
    holderName: r.holder_name,
    holderPersonId: r.holder_person_id,
  }));
}

// Adds passes for one day, one serial number per line. Serials already in stock are skipped.
export async function addPasses(db: Db, actor: Viewer, input: { date: string; serials: string }) {
  assertAdmin(actor);
  if (!isDate(input.date)) throw refuse("sap_date_needed");
  if (!(await getSapDays(db)).includes(input.date)) throw refuse("sap_day_not_offered");
  const serials = [
    ...new Set(
      input.serials
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!serials.length) throw refuse("sap_serial_needed");
  if (serials.some((s) => s.length > 60)) throw refuse("sap_serial_too_long");
  const season = await currentSeason(db);
  const added = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(sapPass)
      .values(serials.map((serial) => ({ burnId: season.id, validDate: input.date, serial })))
      .onConflictDoNothing()
      .returning({ id: sapPass.id, serial: sapPass.serial });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "sap_passes_added",
      subjectType: "sap_pass",
      subjectId: null,
      after: { date: input.date, serials: rows.map((r) => r.serial) },
    });
    return rows.length;
  });
  return { added, skipped: serials.length - added };
}

async function deleteObject(env: Env, key: string | null) {
  if (!key) return;
  try {
    await env.PHOTOS.delete(key);
  } catch (e) {
    console.error(`sap pdf cleanup failed: ${e instanceof Error ? e.name : "error"}`);
  }
}

export async function deletePass(db: Db, env: Env, actor: Viewer, passId: string) {
  assertAdmin(actor);
  const key = await db.transaction(async (tx) => {
    const [pass] = await tx.select().from(sapPass).where(eq(sapPass.id, passId)).for("update");
    if (!pass) throw refuse("not_found", 404);
    if (pass.holderParticipationId) throw refuse("sap_pass_assigned", 409);
    await tx.delete(sapPass).where(eq(sapPass.id, passId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "sap_pass_deleted",
      subjectType: "sap_pass",
      subjectId: passId,
      before: { date: pass.validDate, serial: pass.serial },
    });
    return pass.pdfKey;
  });
  await deleteObject(env, key);
}

export function isPdf(bytes: Uint8Array) {
  return (
    bytes.length > 5 &&
    bytes[0] === 0x25 && // %PDF-
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

// Stores a pass's PDF (replacing any earlier one) in the private bucket. If the pass is
// already assigned to an approved camper, they're emailed that it's ready.
export async function setPassPdf(
  db: Db,
  env: Env,
  campId: string,
  actor: Viewer,
  passId: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  assertAdmin(actor);
  if (bytes.byteLength === 0) throw refuse("sap_pdf_missing");
  if (bytes.byteLength > MAX_PDF_BYTES) throw refuse("sap_pdf_too_large");
  if (!isPdf(bytes)) throw refuse("sap_pdf_bad_type");
  const [exists] = await db.select({ id: sapPass.id }).from(sapPass).where(eq(sapPass.id, passId));
  if (!exists) throw refuse("not_found", 404);

  const key = newKey(campId, "sap", "pdf");
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  let oldKey: string | null = null;
  let holder: { email: string | null; date: string } | null = null;
  try {
    await db.transaction(async (tx) => {
      const [pass] = await tx.select().from(sapPass).where(eq(sapPass.id, passId)).for("update");
      if (!pass) throw refuse("not_found", 404);
      oldKey = pass.pdfKey;
      await tx
        .update(sapPass)
        .set({ pdfKey: key, pdfUploadedAt: new Date() })
        .where(eq(sapPass.id, passId));
      await audit(tx, {
        actorPersonId: actor.personId,
        action: "sap_pdf_uploaded",
        subjectType: "sap_pass",
        subjectId: passId,
        after: { serial: pass.serial },
      });
      if (pass.holderParticipationId) {
        holder = await approvedHolderEmail(tx, pass.holderParticipationId, pass.validDate);
      }
    });
  } catch (e) {
    await deleteObject(env, key);
    throw e;
  }
  await deleteObject(env, oldKey);
  const h = holder as { email: string | null; date: string } | null;
  if (h?.email) await sendSapReady(db, env, h.email, h.date);
}

export async function removePassPdf(db: Db, env: Env, actor: Viewer, passId: string) {
  assertAdmin(actor);
  const [pass] = await db.select().from(sapPass).where(eq(sapPass.id, passId));
  if (!pass?.pdfKey) return;
  await db.update(sapPass).set({ pdfKey: null, pdfUploadedAt: null }).where(eq(sapPass.id, passId));
  await audit(db, {
    actorPersonId: actor.personId,
    action: "sap_pdf_removed",
    subjectType: "sap_pass",
    subjectId: passId,
  });
  await deleteObject(env, pass.pdfKey);
}

async function approvedHolderEmail(tx: Tx, participationId: string, date: string) {
  const [row] = await tx
    .select({ email: person.email, status: sapReview.status })
    .from(participation)
    .innerJoin(person, eq(person.id, participation.personId))
    .leftJoin(sapReview, eq(sapReview.participationId, participation.id))
    .where(eq(participation.id, participationId));
  return row?.status === "approved" ? { email: row.email, date } : null;
}

const signInLink = (env: Env, email: string) => {
  const url = new URL("/sign-in", env.APP_URL);
  url.searchParams.set("email", email);
  return url.toString();
};

async function sendSapReady(db: Db, env: Env, email: string, date: string) {
  await sendMail(db, env, "sap_ready", email, {
    url: signInLink(env, email),
    day: formatSapDay(date),
  });
}

// ─── Requests and decisions (Leads) ────────────────────────────────────────────────────────

export type SapRequestRow = {
  participationId: string;
  personId: string;
  name: string;
  intent: string | null;
  requested: boolean;
  requestedDate: string | null;
  arrivalDate: string | null;
  status: "pending" | "approved" | "denied";
  approvedDate: string | null;
  flagged: boolean;
  decidedBy: string | null;
  pass: { id: string; serial: string; validDate: string; hasPdf: boolean } | null;
};

// Everyone this season who asked for a SAP (and is coming), plus anyone with a decision whose
// plans have since changed, so Leads can see and tidy those up.
export async function sapBoard(db: Db) {
  const season = await currentSeason(db);
  const rows = await db.execute<{
    participation_id: string;
    person_id: string;
    name: string;
    intent: string | null;
    requested: boolean | null;
    requested_date: string | null;
    arrival_date: string | null;
    status: "approved" | "denied" | null;
    approved_date: string | null;
    flagged: boolean | null;
    decided_by: string | null;
    pass_id: string | null;
    serial: string | null;
    valid_date: string | null;
    has_pdf: boolean | null;
  }>(sql`
    select pa.id as participation_id, p.id as person_id,
      coalesce(p.playa_name, p.legal_name) as name, pa.intent,
      pa.sap_requested as requested, pa.sap_date::text as requested_date,
      pa.arrival_date::text as arrival_date,
      r.status, r.approved_date::text as approved_date, r.flagged,
      coalesce(db.playa_name, db.legal_name) as decided_by,
      s.id as pass_id, s.serial, s.valid_date::text as valid_date, s.pdf_key is not null as has_pdf
    from participation pa
    join person p on p.id = pa.person_id and p.active
    left join sap_review r on r.participation_id = pa.id
    left join person db on db.id = r.decided_by_person_id
    left join sap_pass s on s.holder_participation_id = pa.id
    where pa.burn_id = ${season.id}
      and ((pa.sap_requested and pa.intent in ('going', 'leaning_yes')) or r.id is not null)
    order by coalesce(pa.sap_date, '9999-12-31'), lower(coalesce(p.playa_name, p.legal_name))
  `);
  const requests: SapRequestRow[] = rows.map((r) => ({
    participationId: r.participation_id,
    personId: r.person_id,
    name: r.name,
    intent: r.intent,
    requested: r.requested === true && coming(r.intent),
    requestedDate: r.requested_date,
    arrivalDate: r.arrival_date,
    status: r.status ?? "pending",
    approvedDate: r.approved_date,
    flagged: r.flagged === true,
    decidedBy: r.decided_by,
    pass: r.pass_id
      ? {
          id: r.pass_id,
          serial: r.serial as string,
          validDate: r.valid_date as string,
          hasPdf: r.has_pdf === true,
        }
      : null,
  }));
  const passes = await listPasses(db);
  const byDay = new Map<string, { total: number; available: number }>();
  for (const p of passes) {
    const d = byDay.get(p.validDate) ?? { total: 0, available: 0 };
    d.total++;
    if (!p.holderName) d.available++;
    byDay.set(p.validDate, d);
  }
  return {
    requests,
    available: passes.filter((p) => !p.holderName),
    stock: [...byDay.entries()].map(([date, n]) => ({ date, ...n })),
  };
}

export type SapDecision =
  | { action: "approve"; day?: string; passId?: string }
  | { action: "deny" }
  | { action: "undo" }
  | { action: "release" };

// Records a Lead's decision. Approving with a pass assigns that pass (its date becomes the
// approved day, whatever day was asked for); without one it approves for a day, and a pass
// can be assigned later. Emails: "approved" the first time, and "ready" once the camper holds
// a pass that has its PDF.
export async function decideSap(
  db: Db,
  env: Env,
  actor: Viewer,
  participationId: string,
  decision: SapDecision,
) {
  assertLead(actor);
  const season = await currentSeason(db);
  const result = await db.transaction(async (tx) => {
    const [pa] = await tx
      .select()
      .from(participation)
      .where(and(eq(participation.id, participationId), eq(participation.burnId, season.id)))
      .for("update");
    if (!pa) throw refuse("not_found", 404);
    const [before] = await tx
      .select()
      .from(sapReview)
      .where(eq(sapReview.participationId, participationId));
    const [holder] = await tx
      .select({ email: person.email })
      .from(person)
      .where(eq(person.id, pa.personId));
    const log = (action: string, after: unknown) =>
      audit(tx, {
        actorPersonId: actor.personId,
        action,
        subjectType: "person",
        subjectId: pa.personId,
        before: before ? { status: before.status, day: before.approvedDate } : null,
        after,
      });

    if (decision.action === "undo") {
      await releasePassesOf(tx, participationId);
      await tx.delete(sapReview).where(eq(sapReview.participationId, participationId));
      await log("sap_decision_undone", null);
      return null;
    }
    if (decision.action === "release") {
      await releasePassesOf(tx, participationId);
      await tx
        .update(sapReview)
        .set({ flagged: false })
        .where(eq(sapReview.participationId, participationId));
      await log("sap_pass_released", null);
      return null;
    }
    if (decision.action === "deny") {
      await releasePassesOf(tx, participationId);
      const values = { status: "denied" as const, approvedDate: null, flagged: false };
      await tx
        .insert(sapReview)
        .values({ participationId, decidedByPersonId: actor.personId, ...values })
        .onConflictDoUpdate({
          target: sapReview.participationId,
          set: { ...values, decidedByPersonId: actor.personId, decidedAt: new Date() },
        });
      await log("sap_denied", { status: "denied" });
      return null;
    }

    // Approve.
    if (!pa.sapRequested || !coming(pa.intent)) throw refuse("sap_not_requested", 409);
    let day = decision.day && isDate(decision.day) ? decision.day : pa.sapDate;
    let pass: typeof sapPass.$inferSelect | undefined;
    if (decision.passId) {
      [pass] = await tx
        .select()
        .from(sapPass)
        .where(and(eq(sapPass.id, decision.passId), eq(sapPass.burnId, season.id)))
        .for("update");
      if (!pass) throw refuse("not_found", 404);
      if (pass.holderParticipationId && pass.holderParticipationId !== participationId) {
        throw refuse("sap_pass_taken", 409);
      }
      day = pass.validDate;
    }
    if (!day) throw refuse("sap_day_needed");
    // Without a specific pass, the day must be one of this season's SAP days.
    if (!pass && !(season.sapDays ?? []).includes(day)) throw refuse("sap_day_not_offered");
    if (pass && pass.holderParticipationId !== participationId) {
      await releasePassesOf(tx, participationId);
      await tx
        .update(sapPass)
        .set({
          holderParticipationId: participationId,
          assignedByPersonId: actor.personId,
          assignedAt: new Date(),
        })
        .where(eq(sapPass.id, pass.id));
    }
    const values = { status: "approved" as const, approvedDate: day, flagged: false };
    await tx
      .insert(sapReview)
      .values({ participationId, decidedByPersonId: actor.personId, ...values })
      .onConflictDoUpdate({
        target: sapReview.participationId,
        set: { ...values, decidedByPersonId: actor.personId, decidedAt: new Date() },
      });
    await log("sap_approved", { status: "approved", day, serial: pass?.serial ?? null });
    return {
      email: holder?.email ?? null,
      day,
      newlyApproved: before?.status !== "approved",
      readyNow: !!pass?.pdfKey && pass.holderParticipationId !== participationId,
    };
  });

  if (result?.email) {
    if (result.readyNow) await sendSapReady(db, env, result.email, result.day);
    else if (result.newlyApproved) {
      await sendMail(db, env, "sap_approved", result.email, {
        url: signInLink(env, result.email),
        day: formatSapDay(result.day),
      });
    }
  }
}

// ─── Campers ───────────────────────────────────────────────────────────────────────────────

export async function mySap(db: Db, personId: string) {
  const season = await currentSeason(db);
  const [row] = await db
    .select({
      requested: participation.sapRequested,
      requestedDate: participation.sapDate,
      intent: participation.intent,
      status: sapReview.status,
      approvedDate: sapReview.approvedDate,
      passId: sapPass.id,
      passDate: sapPass.validDate,
      pdfKey: sapPass.pdfKey,
    })
    .from(participation)
    .leftJoin(sapReview, eq(sapReview.participationId, participation.id))
    .leftJoin(sapPass, eq(sapPass.holderParticipationId, participation.id))
    .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)));
  if (!row || !coming(row.intent) || row.requested !== true) return null;
  return {
    status: (row.status ?? "pending") as "pending" | "approved" | "denied",
    requestedDate: row.requestedDate,
    approvedDate: row.approvedDate,
    passDate: row.passDate,
    downloadId: row.passId && row.pdfKey && row.status === "approved" ? row.passId : null,
  };
}

// The PDF a viewer may download: the pass's own holder (while approved), or any Lead.
export async function sapPdfFor(db: Db, viewer: Viewer, passId: string) {
  const [row] = await db
    .select({
      key: sapPass.pdfKey,
      serial: sapPass.serial,
      date: sapPass.validDate,
      holderPersonId: participation.personId,
      status: sapReview.status,
    })
    .from(sapPass)
    .leftJoin(participation, eq(participation.id, sapPass.holderParticipationId))
    .leftJoin(sapReview, eq(sapReview.participationId, sapPass.holderParticipationId))
    .where(eq(sapPass.id, passId));
  if (!row?.key) return null;
  const isHolder = row.holderPersonId === viewer.personId && row.status === "approved";
  return isHolder || can(viewer, "saps") ? row : null;
}
