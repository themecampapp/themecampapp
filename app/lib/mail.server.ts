// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { appSetting, type SEND_STATUSES, sendLog } from "~/db/schema";
import { currentYear } from "./data/participation.server";
import type { Db } from "./db.server";
import { type EmailEnv, type SendResult, sendEmail } from "./email/provider";
import { textToHtml } from "./email-html";
import {
  ACCOUNT_KINDS,
  CAPPED_KINDS,
  DEFAULT_TEMPLATES,
  fill,
  footer,
  isEditable,
  type MailKind,
  type TemplateText,
} from "./email-templates";

// Templates live in email-templates.ts; Admins can override the editable ones (stored in
// app_setting as "email_template:<kind>"). Nothing a visitor typed is ever put into an email.
export type { MailKind } from "./email-templates";

export type MailEnv = EmailEnv & {
  // Sending addresses (a display name, if any, is replaced by the camp's). Camp mail goes from
  // MAIL_FROM; account mail (sign-in, email changes) from AUTH_MAIL_FROM, a separate subdomain.
  MAIL_FROM: string;
  AUTH_MAIL_FROM?: string;
  APP_URL: string;
  // The instance's name (config product.name, open-source plan 3.5): in the sender's display
  // name and every email's footer.
  PRODUCT_NAME: string;
  // Staging only (a Worker secret): comma-separated addresses or "@domain" entries. Mail to
  // anyone else is skipped and logged, so staging can never email a real camper.
  MAIL_ALLOWLIST?: string;
  // "true" on a restricted instance (staging, config mail.restricted): with no allowlist, send
  // nothing rather than to everyone.
  MAIL_RESTRICTED?: string;
};

export function mailAllowed(
  allowlist: string | undefined,
  to: string,
  restricted = false,
): boolean {
  const entries = (allowlist ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return !restricted;
  const addr = to.trim().toLowerCase();
  return entries.some((e) => (e.startsWith("@") ? addr.endsWith(e) : addr === e));
}

type Template = { subject: string; text: string };

export const templateKey = (kind: MailKind) => `email_template:${kind}`;

// An Admin's saved version of an editable template, if any.
export async function templateOverride(db: Db, kind: MailKind): Promise<TemplateText | null> {
  if (!isEditable(kind)) return null;
  const [row] = await db
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, templateKey(kind)));
  const v = row?.value as Partial<TemplateText> | null | undefined;
  return v && typeof v.subject === "string" && typeof v.body === "string"
    ? { subject: v.subject, body: v.body }
    : null;
}

export function renderTemplate(
  kind: MailKind,
  data: { url: string; year: number; day?: string; camp: string; product: string },
  override?: TemplateText | null,
): Template {
  const t = override ?? DEFAULT_TEMPLATES[kind];
  const values = {
    link: data.url,
    year: data.year,
    day: data.day,
    camp: data.camp,
    product: data.product,
  };
  return { subject: fill(t.subject, values), text: fill(t.body, values) };
}

export type SendStatus = (typeof SEND_STATUSES)[number];

// Everything a send needs to know about the camp, in one read. `camp` has no row-level
// security, so the camp is picked explicitly; camp_settings is this camp's row by RLS.
type Sender = {
  name: string;
  contactEmail: string | null;
  kind: "camp" | "demo";
  status: string;
  paused: boolean;
  dailyCap: number;
};

async function sender(db: Db): Promise<Sender> {
  const [row] = await db.execute<{
    name: string;
    contact_email: string | null;
    kind: "camp" | "demo";
    status: string;
    sending_paused: boolean;
    daily_send_cap: number;
  }>(sql`
    select coalesce(s.display_name, c.name) as name, s.contact_email, c.kind, c.status,
      c.sending_paused, c.daily_send_cap
    from camp_settings s join camp c on c.id = s.camp_id
    where c.id = current_camp_id()`);
  if (!row) throw new Error("no camp is set for this email");
  return {
    name: row.name,
    contactEmail: row.contact_email,
    kind: row.kind,
    status: row.status,
    paused: row.sending_paused,
    dailyCap: Number(row.daily_send_cap),
  };
}

// The camp's name, for {camp}: its own display name, or the platform's name for it.
export async function campName(db: Db): Promise<string> {
  return (await sender(db)).name;
}

const addressOf = (from: string) => from.match(/<([^>]+)>/)?.[1] ?? from.trim();

// "Camp Name via <product>" <notify@...>. The name is already checked on save; quotes,
// backslashes and angle brackets are dropped anyway so it can't break the header.
function fromAddress(env: MailEnv, kind: MailKind, camp: string) {
  const email = addressOf(
    ACCOUNT_KINDS.has(kind) ? (env.AUTH_MAIL_FROM ?? env.MAIL_FROM) : env.MAIL_FROM,
  );
  return { name: `${camp} via ${env.PRODUCT_NAME}`.replace(/["\\<>\r\n]/g, ""), email };
}

// Capped mail this camp sent in the last 24 hours.
async function sentToday(db: Db): Promise<number> {
  const kinds = sql.join(
    [...CAPPED_KINDS].map((k) => sql`${k}`),
    sql`, `,
  );
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from send_log
    where status = 'sent' and kind in (${kinds}) and created_at > now() - interval '24 hours'`);
  return Number(row?.n ?? 0);
}

// Which of these addresses no camp may email (the list itself stays out of reach).
async function suppressed(db: Db, recipients: string[]): Promise<Set<string>> {
  if (!recipients.length) return new Set();
  const list = sql.join(
    recipients.map((r) => sql`${r}`),
    sql`, `,
  );
  const rows = await db.execute<{ email: string }>(
    sql`select suppressed_emails(array[${list}]::text[]) as email`,
  );
  return new Set(rows.map((r) => r.email));
}

type Hold = { status: SendStatus; error: string };

// The checks before any email leaves (R14, R36), in order. Returns, for each recipient, why it
// won't be sent, or nothing when it may. `null` means don't log either: a demo camp's
// database is read-only and it never sends mail, nor does a suspended camp outside sign-in.
async function holds(
  db: Db,
  env: MailEnv,
  kind: MailKind,
  recipients: string[],
  camp: Sender,
): Promise<Array<Hold | null> | null> {
  const account = ACCOUNT_KINDS.has(kind);
  if (camp.kind === "demo") return null;
  if (camp.status !== "active" && !account) return null;
  // One entry per message, in order: the same address can appear twice (people who share
  // an email), and each copy counts against the daily limit on its own.
  const held: Array<Hold | null> = [];
  const blocked = await suppressed(db, recipients);
  let room = CAPPED_KINDS.has(kind) ? Math.max(0, camp.dailyCap - (await sentToday(db))) : Infinity;
  for (const to of recipients) {
    if (!mailAllowed(env.MAIL_ALLOWLIST, to, env.MAIL_RESTRICTED === "true")) {
      held.push({ status: "skipped", error: "not on MAIL_ALLOWLIST" });
    } else if (blocked.has(to.toLowerCase())) {
      held.push({ status: "suppressed", error: "address bounced or complained" });
    } else if (camp.paused && !account) {
      held.push({ status: "paused", error: "the camp's sending is paused" });
    } else if (room <= 0) {
      held.push({ status: "capped", error: `over the daily limit of ${camp.dailyCap}` });
    } else {
      room -= 1;
      held.push(null);
    }
  }
  return held;
}

type Message = { to: string; subject: string; text: string; url: string };

// Hands one email to the instance's provider (app/lib/email/provider.ts).
function deliver(env: MailEnv, kind: MailKind, camp: Sender, m: Message): Promise<SendResult> {
  const text = m.text + footer(kind, camp.name, env.PRODUCT_NAME);
  return sendEmail(env, {
    to: m.to,
    from: fromAddress(env, kind, camp.name),
    ...(camp.contactEmail ? { replyTo: camp.contactEmail } : {}),
    subject: m.subject,
    html: textToHtml(text, m.url),
    text,
  });
}

// Sends one email and records the attempt in send_log, including every reason it wasn't sent.
// Never logs the URL or body: magic links are credentials.
export async function sendMail(
  db: Db,
  env: MailEnv,
  kind: MailKind,
  to: string,
  data: { url: string; day?: string },
): Promise<SendStatus> {
  const camp = await sender(db);
  const held = await holds(db, env, kind, [to], camp);
  if (!held) return "skipped";
  const hold = held[0];
  if (hold) {
    await db.insert(sendLog).values({ kind, recipient: to, ...hold });
    return hold.status;
  }
  const { subject, text } = renderTemplate(
    kind,
    { ...data, year: await currentYear(db), camp: camp.name, product: env.PRODUCT_NAME },
    await templateOverride(db, kind),
  );
  const { error, providerId } = await deliver(env, kind, camp, {
    to,
    subject,
    text,
    url: data.url,
  });
  await db
    .insert(sendLog)
    .values({ kind, recipient: to, status: error ? "failed" : "sent", error, providerId });
  if (error) console.error(`mail ${kind} failed: ${error}`);
  return error ? "failed" : "sent";
}

export type BatchResult = {
  sent: number;
  // Everyone not sent, whatever the reason.
  failed: string[];
  // How many weren't sent for each reason other than a failed send.
  held: Partial<Record<SendStatus, number>>;
};

const SEND_CONCURRENCY = 5;

// Many emails of one kind (bulk invites, RSVP nudges), each with its own link.
export async function sendMailBatch(
  db: Db,
  env: MailEnv,
  kind: MailKind,
  messages: Array<{ to: string; url: string }>,
  // The same subject and text for everyone, already written (an announcement), instead of the
  // kind's template.
  content?: Template,
): Promise<BatchResult> {
  const result: BatchResult = { sent: 0, failed: [], held: {} };
  const camp = await sender(db);
  const held = await holds(
    db,
    env,
    kind,
    messages.map((m) => m.to),
    camp,
  );
  if (!held)
    return { ...result, failed: messages.map((m) => m.to), held: { skipped: messages.length } };
  const holding = messages
    .map((m, i) => ({ m, h: held[i] }))
    .filter((x): x is { m: (typeof messages)[number]; h: Hold } => x.h !== null);
  if (holding.length) {
    await db.insert(sendLog).values(
      holding.map(({ m, h }) => {
        // Suppressed counts as a plain failure for the Lead (see notSentError).
        if (h.status !== "suppressed") result.held[h.status] = (result.held[h.status] ?? 0) + 1;
        return { kind, recipient: m.to, ...h };
      }),
    );
    result.failed.push(...holding.map(({ m }) => m.to));
  }
  const allowed = messages.filter((_, i) => held[i] === null);
  const year = await currentYear(db);
  const override = await templateOverride(db, kind);
  // Providers take one message per request; a few at a time keeps a bulk invite quick without
  // tripping their rate limits (Plunk's is 1,000 requests a minute per project).
  for (let i = 0; i < allowed.length; i += SEND_CONCURRENCY) {
    const chunk = allowed.slice(i, i + SEND_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map((m) => {
        const t =
          content ??
          renderTemplate(
            kind,
            { url: m.url, year, camp: camp.name, product: env.PRODUCT_NAME },
            override,
          );
        return deliver(env, kind, camp, { to: m.to, subject: t.subject, text: t.text, url: m.url });
      }),
    );
    chunk.forEach((m, j) => {
      if (outcomes[j].error) result.failed.push(m.to);
      else result.sent += 1;
    });
    const firstError = outcomes.find((o) => o.error)?.error;
    if (firstError) console.error(`mail batch ${kind} failed: ${firstError}`);
    await db.insert(sendLog).values(
      chunk.map((m, j) => ({
        kind,
        recipient: m.to,
        status: outcomes[j].error ? ("failed" as const) : ("sent" as const),
        error: outcomes[j].error,
        providerId: outcomes[j].providerId,
      })),
    );
  }
  return result;
}

// A single email that wasn't sent, as an error for the page to show (see errors.ts). A
// suppressed address reads as an ordinary failure: the list is every camp's, so saying an
// address is on it would tell one camp about another's mail.
export function notSentError(status: Exclude<SendStatus, "sent">) {
  const reason =
    status === "capped" ? "daily_limit" : status === "paused" ? "sending_paused" : "send_failed";
  return data({ reason }, { status: status === "failed" ? 502 : 409 });
}

// What to tell a Lead about mail that wasn't sent, beyond plain failures.
export function heldNotice(held: BatchResult["held"]): string | null {
  const parts = [
    held.capped &&
      `${held.capped} held back: this camp reached today's email limit. Try them again tomorrow.`,
    held.paused &&
      `${held.paused} held back: this camp's email is paused while bounces or spam reports are looked into.`,
    held.skipped && `${held.skipped} skipped.`,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}
