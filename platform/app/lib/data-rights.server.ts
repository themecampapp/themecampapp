// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { strToU8, zipSync } from "fflate";
import type postgres from "postgres";
import { data } from "react-router";
import { campOrigin } from "../../../app/lib/hosts";
import type { Operator } from "./context.server";
import { sendPlatformMail } from "./mail.server";

// Pilot data rights (R43–R45a). The operator records what someone asked for; nothing happens
// until the requester confirms it from a link sent to their account's email (on the camp's own
// site); then the console can carry it out. Every step is in the operator log, and in the camp's
// audit log where the camp still exists.

export type RequestKind = "export" | "delete_camp" | "delete_login";

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_DAYS = 7;
export const GRACE_DAYS = 30;
export const EXPORT_DAYS = 7;
// The most file bytes one export takes in (the zip is built in memory; a Worker has 128 MB).
export const EXPORT_MAX_BYTES = 60 * 1024 * 1024;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function sha256(value: string) {
  return b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

async function log(
  tx: postgres.TransactionSql,
  operator: Operator | null,
  campId: string | null,
  action: string,
  detail = "",
) {
  await tx`
    insert into operator_log (operator_id, kind, subject_camp_id, action, detail)
    values (${operator?.id ?? null}, ${operator ? "console_action" : "system_job"}, ${campId},
      ${action}, ${detail})`;
}

async function campAudit(
  tx: postgres.TransactionSql,
  operator: Operator,
  action: string,
  subjectType: string,
  subjectId: string | null,
  after: Record<string, unknown> = {},
) {
  await tx`
    insert into audit_log (actor_type, actor_operator_id, action, subject_type, subject_id, after)
    values ('operator', ${operator.id}, ${action}, ${subjectType}, ${subjectId}, ${tx.json(after as postgres.JSONValue)})`;
}

const describe = (kind: RequestKind, campName: string, email: string, product: string) =>
  kind === "export"
    ? `a full copy of ${campName}'s data, which its Admins can download from the camp's site for ${EXPORT_DAYS} days`
    : kind === "delete_camp"
      ? `deleting ${campName} and everything in it. The camp closes at once; after ${GRACE_DAYS} days its data is gone for good`
      : `deleting the ${product} login ${email}: your name and contact details are removed from every camp you're in, and you can't sign in any more`;

// Records a request and emails the confirmation link. For an export or a camp deletion the
// requester must be an active Admin of the camp; for a login deletion, a person in the camp
// with that login.
export async function createRequest(
  sql: postgres.Sql,
  env: PlatformEnv,
  operator: Operator,
  input: { campId: string; kind: string; email: string },
) {
  if (!ID_RE.test(input.campId)) throw refuse("camp_not_found", 404);
  const kind = input.kind as RequestKind;
  if (!["export", "delete_camp", "delete_login"].includes(kind))
    throw refuse("request_kind_needed");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw refuse("request_email_needed");
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);

  const result = (await sql.begin(async (tx) => {
    const [c] = await tx<{ slug: string; name: string; status: string }[]>`
      select slug, name, status from camp where id = ${input.campId}`;
    if (!c) throw refuse("camp_not_found", 404);
    if (c.status === "pending_deletion") throw refuse("camp_pending_deletion", 409);
    await tx`select set_config('app.camp_id', ${input.campId}, true)`;
    const [found] =
      kind === "delete_login"
        ? await tx`
            select 1 from person where auth_user_id = login_id(${email})`
        : await tx`
            select 1 from person p join member_role r on r.person_id = p.id
            where r.role = 'admin' and r.revoked_at is null and p.active and lower(p.email) = ${email}`;
    if (!found) throw refuse(kind === "delete_login" ? "request_no_login" : "request_not_admin");
    const [r] = await tx<{ id: string }[]>`
      insert into data_request (kind, requester_email, token_hash, token_expires_at, created_by_operator_id)
      values (${kind}, ${email}, ${tokenHash}, now() + make_interval(days => ${LINK_DAYS}), ${operator.id})
      returning id`;
    await log(tx, operator, input.campId, `request_${kind}`, "confirmation link sent");
    return { id: r.id, ...c };
  })) as { id: string; slug: string; name: string };

  const link = `${campOrigin(result.slug, env.PLATFORM_DOMAIN, env)}/confirm/request/${token}`;
  await sendPlatformMail(
    env,
    sql,
    [email],
    `Please confirm your request to ${env.PRODUCT_NAME}`,
    [
      `You asked ${env.PRODUCT_NAME} for ${describe(kind, result.name, email, env.PRODUCT_NAME)}.`,
      "",
      `Nothing happens until you confirm. Open this link and press the button (it works for ${LINK_DAYS} days):`,
      link,
      "",
      "If you didn't ask for this, ignore this email.",
    ].join("\n"),
  );
  return result.id;
}

export type RequestRow = {
  id: string;
  campId: string;
  slug: string | null;
  kind: RequestKind;
  createdAt: string;
  state: "waiting" | "expired" | "confirmed" | "done";
};

export async function listRequests(sql: postgres.Sql): Promise<RequestRow[]> {
  const rows = await sql<
    {
      id: string;
      camp_id: string;
      slug: string | null;
      kind: RequestKind;
      created_at: string;
      token_expires_at: Date;
      confirmed_at: Date | null;
      completed_at: Date | null;
    }[]
  >`
    select r.id, r.camp_id, c.slug, r.kind, r.created_at::text, r.token_expires_at, r.confirmed_at,
      r.completed_at
    from data_requests() r left join camp c on c.id = r.camp_id`;
  return rows.map((r) => ({
    id: r.id,
    campId: r.camp_id,
    slug: r.slug,
    kind: r.kind,
    createdAt: r.created_at,
    state: r.completed_at
      ? "done"
      : r.confirmed_at
        ? "confirmed"
        : r.token_expires_at.getTime() < Date.now()
          ? "expired"
          : "waiting",
  }));
}

// The request, if it's confirmed and not done yet (as its camp); refuses otherwise.
async function confirmedRequest(tx: postgres.TransactionSql, campId: string, requestId: string) {
  if (!ID_RE.test(campId) || !ID_RE.test(requestId)) throw refuse("request_not_found", 404);
  await tx`select set_config('app.camp_id', ${campId}, true)`;
  const [r] = await tx<
    {
      id: string;
      kind: RequestKind;
      requester_email: string;
      confirmed_at: Date | null;
      completed_at: Date | null;
    }[]
  >`
    select id, kind, requester_email, confirmed_at, completed_at from data_request
    where id = ${requestId} for update`;
  if (!r) throw refuse("request_not_found", 404);
  if (r.completed_at) throw refuse("request_done", 409);
  if (!r.confirmed_at) throw refuse("request_not_confirmed", 409);
  return r;
}

// R44: the camp closes now and is deleted for good after the grace period. Its Admins can ask
// the operator to restore it until then.
export async function deleteCamp(
  sql: postgres.Sql,
  operator: Operator,
  campId: string,
  requestId: string,
) {
  await sql.begin(async (tx) => {
    const r = await confirmedRequest(tx, campId, requestId);
    if (r.kind !== "delete_camp") throw refuse("request_not_found", 404);
    const [c] = await tx`
      update camp set status = 'pending_deletion', delete_after = now() + make_interval(days => ${GRACE_DAYS})
      where id = ${campId} and status <> 'pending_deletion' returning id`;
    if (!c) throw refuse("camp_pending_deletion", 409);
    await tx`update data_request set completed_at = now() where id = ${requestId}`;
    await campAudit(tx, operator, "camp_deletion_scheduled", "camp", campId, { days: GRACE_DAYS });
    await log(
      tx,
      operator,
      campId,
      "camp_deletion_scheduled",
      `deleted for good after ${GRACE_DAYS} days`,
    );
  });
}

export async function restoreCamp(
  sql: postgres.Sql,
  operator: Operator,
  campId: string,
  reason: string,
) {
  if (!ID_RE.test(campId)) throw refuse("camp_not_found", 404);
  if (!reason.trim()) throw refuse("reason_needed");
  await sql.begin(async (tx) => {
    const [c] = await tx`
      update camp set status = 'active', delete_after = null
      where id = ${campId} and status = 'pending_deletion' returning id`;
    if (!c) throw refuse("not_pending_deletion", 409);
    await tx`select set_config('app.camp_id', ${campId}, true)`;
    await campAudit(tx, operator, "camp_deletion_cancelled", "camp", campId, {
      reason: reason.trim(),
    });
    await log(tx, operator, campId, "camp_deletion_cancelled", reason.trim());
  });
}

// R45: the login goes, and in every camp the person records linked to it keep only what the
// camp needs for its history ("a deleted member"): names, contact details, notes and photos
// are removed, and the email is taken out of the sign-in and send logs. Audit rows stay.
export async function deleteLogin(
  sql: postgres.Sql,
  env: PlatformEnv,
  operator: Operator,
  campId: string,
  requestId: string,
) {
  const photos: string[] = [];
  await sql.begin(async (tx) => {
    const r = await confirmedRequest(tx, campId, requestId);
    if (r.kind !== "delete_login") throw refuse("request_not_found", 404);
    const email = r.requester_email;
    const [u] = await tx<{ id: string | null }[]>`select login_id(${email}) as id`;
    const camps = u.id
      ? (await tx<{ id: string }[]>`select login_camps(${u.id}) as id`).map((c) => c.id)
      : [];
    for (const camp of new Set([...camps, campId])) {
      await tx`select set_config('app.camp_id', ${camp}, true)`;
      const people = u.id
        ? await tx<{ id: string; photo_key: string | null }[]>`
            select id, photo_key from person where auth_user_id = ${u.id}`
        : [];
      const ids = people.map((p) => p.id);
      photos.push(...people.map((p) => p.photo_key).filter((k): k is string => !!k));
      if (ids.length) {
        await tx`
          update person set legal_name = 'a deleted member', playa_name = null, email = null,
            phone = null, home_location = null, mailing_address = null, photo_key = null,
            note_2026 = null,
            active = false, directory_hidden = true, auth_user_id = null, updated_at = now()
          where id in ${tx(ids)}`;
        await tx`delete from invite where person_id in ${tx(ids)}`;
        await tx`delete from email_change where person_id in ${tx(ids)}`;
        await tx`
          update inquiry set name = 'a deleted member', playa_name = null, email = null,
            phone = null, heard_from = null, note = null
          where person_id in ${tx(ids)}`;
      }
      await tx`update auth_event set email = null where lower(email) = ${email}`;
      await tx`update send_log set recipient = '(deleted)' where lower(recipient) = ${email}`;
      await campAudit(tx, operator, "login_deleted", "person", ids[0] ?? null, {
        people: ids.length,
      });
    }
    await tx`select set_config('app.camp_id', ${campId}, true)`;
    await tx`update data_request set completed_at = now(), requester_email = '(deleted)' where id = ${requestId}`;
    await tx`select forget_login(${email})`;
    await log(tx, operator, campId, "login_deleted", `${camps.length || 1} camp(s)`);
  });
  for (const key of photos) await env.FILES.delete(key).catch(() => {});
}

// Tables never exported: secrets (session tokens, token hashes) and the export list itself.
const NOT_EXPORTED = new Set([
  "session",
  "support_grant",
  "data_request",
  "email_change",
  "camp_export",
  "rate_limit",
]);

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s =
    v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Cells starting with =, +, - or @ are treated as formulas by spreadsheets.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

// R43: every camp-owned table as a CSV, plus the camp's photos, pass PDFs and logo, in one
// zip under the camp's prefix, listed on its Admin page for EXPORT_DAYS. Needs a running
// support grant (the operator is looking at the camp's data) and a confirmed request.
export async function exportCamp(
  sql: postgres.Sql,
  env: PlatformEnv,
  operator: Operator,
  campId: string,
  requestId: string,
): Promise<{ key: string; bytes: number }> {
  const files: Record<string, Uint8Array> = {};
  // Checked twice: before any work, then again when the export is recorded.
  const eligible = async (tx: postgres.TransactionSql) => {
    const r = await confirmedRequest(tx, campId, requestId);
    if (r.kind !== "export") throw refuse("request_not_found", 404);
    const [grant] = await tx`
      select 1 from support_grant where revoked_at is null and expires_at > now()`;
    if (!grant) throw refuse("no_support_grant", 409);
  };

  // 1. The rows, in one short read.
  await sql.begin(async (tx) => {
    await eligible(tx);
    const tables = await tx<{ table: string }[]>`
      select c.relname as table from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'camp_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r' order by 1`;
    for (const { table } of tables) {
      if (NOT_EXPORTED.has(table)) continue;
      // Row-level security keeps this to the camp set above.
      const rows = await tx.unsafe(`select * from "${table.replaceAll('"', '""')}" order by 1`);
      const columns = rows.columns.map((c) => c.name);
      const lines = [columns.map(csvCell).join(",")];
      for (const row of rows as unknown as Array<Record<string, unknown>>) {
        lines.push(columns.map((c) => csvCell(row[c])).join(","));
      }
      files[`data/${table}.csv`] = strToU8(`${lines.join("\r\n")}\r\n`);
    }
  });

  // 2. The files and the zip, outside any transaction. The whole zip is built in the Worker's
  // memory, so a camp with more than EXPORT_MAX_BYTES of files is refused, not crashed on.
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: `camps/${campId}/`, cursor });
    for (const o of page.objects) {
      if (o.key.includes("/exports/")) continue;
      total += o.size;
      if (total > EXPORT_MAX_BYTES) throw refuse("export_too_large", 409);
      const obj = await env.FILES.get(o.key);
      if (obj) {
        files[`files/${o.key.slice(`camps/${campId}/`.length)}`] = new Uint8Array(
          await obj.arrayBuffer(),
        );
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const zip = zipSync(files, { level: 6 });
  const bytes = zip.byteLength;
  const key = `camps/${campId}/exports/${crypto.randomUUID()}.zip`;
  await env.FILES.put(key, zip, { httpMetadata: { contentType: "application/zip" } });

  // 3. Recorded, if the request is still open and the grant still running.
  try {
    await sql.begin(async (tx) => {
      await eligible(tx);
      await tx`
        insert into camp_export (key, bytes, expires_at)
        values (${key}, ${bytes}, now() + make_interval(days => ${EXPORT_DAYS}))`;
      await tx`update data_request set completed_at = now() where id = ${requestId}`;
      await campAudit(tx, operator, "camp_exported", "camp", campId, { bytes });
      await log(tx, operator, campId, "camp_exported", `${bytes} bytes`);
    });
  } catch (e) {
    // The commit may have landed even so (a lost connection): the file stays if it's listed.
    // An unlisted leftover goes with the camp's other files when the camp is deleted.
    const listed = await sql
      .begin(async (tx) => {
        await tx`select set_config('app.camp_id', ${campId}, true)`;
        return (await tx`select 1 from camp_export where key = ${key}`).length > 0;
      })
      .catch(() => true);
    if (!listed) await env.FILES.delete(key).catch(() => {});
    throw e;
  }
  return { key, bytes };
}

// Scheduled (hourly): camps past their grace period are deleted for good, rows and files.
export async function finalizeDeletions(sql: postgres.Sql, env: PlatformEnv): Promise<string[]> {
  const due = await sql<{ id: string; slug: string }[]>`
    select id, slug from camp where status = 'pending_deletion' and delete_after < now()`;
  const done: string[] = [];
  for (const c of due) {
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix: `camps/${c.id}/`, cursor });
      if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await sql.begin(async (tx) => {
      // The camp_delete_guard trigger refuses this unless it's really due.
      await tx`delete from camp where id = ${c.id}`;
      await log(tx, null, null, "camp_deleted", `${c.slug}: all rows and files deleted`);
    });
    done.push(c.slug);
  }
  return done;
}

// Scheduled (hourly): exports past their 7 days are removed, file and listing.
export async function expireExports(sql: postgres.Sql, env: PlatformEnv): Promise<number> {
  const camps = await sql<{ id: string }[]>`select id from camp where status <> 'pending_deletion'`;
  let removed = 0;
  for (const c of camps) {
    const keys = (await sql.begin(async (tx) => {
      await tx`select set_config('app.camp_id', ${c.id}, true)`;
      const rows = await tx<{ key: string }[]>`
        delete from camp_export where expires_at <= now() returning key`;
      return rows.map((r) => r.key);
    })) as string[];
    if (keys.length) await env.FILES.delete(keys);
    removed += keys.length;
  }
  return removed;
}
