// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import type { EmailEvent } from "../../../app/lib/email/provider";
import { campHealth, type Health, overLimit, pauseCamp } from "./sending-health.server";

// One bounce or complaint reported by the email provider (R36), already authenticated and
// parsed by the webhook. Only an event that matches a message we sent (send_log_camp: the
// provider's id and the recipient) does anything: it adds the address to the platform-wide
// suppression list, marks that camp's send, recounts the camp's 7-day rates under row-level
// security, and pauses the camp if they're over the line. All in one transaction, recorded
// by event id so a repeat is a no-op.

export type { EmailEvent };

export type Handled =
  | { result: "duplicate" | "ignored" | "unmatched" | "recorded" }
  | { result: "paused"; slug: string; health: Health };

export async function handleEmailEvent(sql: postgres.Sql, event: EmailEvent): Promise<Handled> {
  return (await sql.begin(async (tx) => {
    const [fresh] = await tx`
      insert into email_webhook_event (event_id, type) values (${event.id}, ${event.kind})
      on conflict (event_id) do nothing returning event_id`;
    if (!fresh) return { result: "duplicate" };
    // A soft bounce (mailbox full, try later) isn't a reason to stop mailing someone.
    if (event.kind === "bounce" && !event.permanent) return { result: "ignored" };

    const recipient = event.recipient.trim().toLowerCase();
    const [{ camp_id: campId }] = await tx<{ camp_id: string | null }[]>`
      select send_log_camp(${event.messageId}, ${recipient}) as camp_id`;
    if (!campId) return { result: "unmatched" };

    // A complaint outranks an earlier bounce.
    const reason = event.kind === "bounce" ? "bounce" : "complaint";
    await tx`
      insert into email_suppression (email, reason) values (${recipient}, ${reason})
      on conflict (email) do update set reason = excluded.reason
      where excluded.reason = 'complaint'`;

    await tx`select set_config('app.camp_id', ${campId}, true)`;
    const outcome = event.kind === "bounce" ? "bounced" : "complained";
    await tx`update send_log set outcome = ${outcome} where provider_id = ${event.messageId}`;
    const health = await campHealth(tx);
    if (overLimit(health)) {
      const slug = await pauseCamp(tx, campId);
      if (slug) return { result: "paused", slug, health };
    }
    return { result: "recorded" };
  })) as Handled;
}
