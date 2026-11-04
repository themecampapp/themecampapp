// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";

// R36: a camp whose bounce or complaint rate over the last 7 days passes a threshold has its
// sending paused, and the operator is told. Email providers ask senders to stay under 4% bounces and
// 0.08% complaints; these sit at those lines. Too few sends say nothing, so under
// MIN_SENDS nothing is paused.
export const BOUNCE_LIMIT = 0.04;
export const COMPLAINT_LIMIT = 0.001;
export const MIN_SENDS = 20;

type Tx = postgres.TransactionSql;

export type Health = { sends: number; bounces: number; complaints: number };

// Counts within the camp this transaction is set to (row-level security on send_log).
export async function campHealth(tx: Tx): Promise<Health> {
  const [row] = await tx<Health[]>`
    select count(*) filter (where status = 'sent')::int as sends,
      count(*) filter (where outcome = 'bounced')::int as bounces,
      count(*) filter (where outcome = 'complained')::int as complaints
    from send_log where created_at > now() - interval '7 days'`;
  return row;
}

export function overLimit(h: Health) {
  if (h.sends < MIN_SENDS) return false;
  return h.bounces / h.sends > BOUNCE_LIMIT || h.complaints / h.sends > COMPLAINT_LIMIT;
}

// Pauses the camp unless it already is. Returns its slug when this call paused it.
export async function pauseCamp(tx: Tx, campId: string): Promise<string | null> {
  const [row] = await tx<{ slug: string }[]>`
    update camp set sending_paused = true
    where id = ${campId} and not sending_paused returning slug`;
  return row?.slug ?? null;
}

// The operator's alert: only the camp's address and the numbers, nothing anyone typed.
export function alertText(slug: string, domain: string, h: Health) {
  const pct = (n: number) => `${((n / h.sends) * 100).toFixed(2)}%`;
  return [
    `Email from ${slug}.${domain} is paused.`,
    "",
    `In the last 7 days it sent ${h.sends} emails: ${h.bounces} bounced (${pct(h.bounces)}) and ${h.complaints} were reported as spam (${pct(h.complaints)}).`,
    `Limits: ${BOUNCE_LIMIT * 100}% bounces, ${COMPLAINT_LIMIT * 100}% complaints.`,
    "",
    "Look into it, then clear camp.sending_paused to resume.",
  ].join("\n");
}
