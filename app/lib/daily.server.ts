// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sendDueReminders } from "./data/reminders.server";
import { campDb, createClients, endClients } from "./db.server";
import { campOrigin } from "./hosts";

// The camp Worker's daily job (config crons.camps): each live camp's key-date
// reminders, acting for one camp at a time exactly as a request would. Demo, suspended and
// closing camps are skipped. One camp's failure doesn't stop the others.
export async function runDaily(env: Env) {
  const clients = createClients(env.HYPERDRIVE.connectionString);
  try {
    // The camp table has no row-level security (see tenancy.server.ts).
    const camps = await clients.pool<Array<{ id: string; slug: string }>>`
      select id, slug from camp where status = 'active' and kind = 'camp' order by slug`;
    for (const camp of camps) {
      try {
        const db = campDb(clients, camp.id, { readOnly: false });
        const sent = await sendDueReminders(db, {
          ...env,
          APP_URL: campOrigin(camp.slug, env.APP_HOST_SUFFIX, env),
        });
        for (const r of sent) {
          console.log(`reminder ${camp.slug} "${r.label}": ${r.sent} of ${r.recipients} sent`);
        }
      } catch (e) {
        console.error(`daily job failed for ${camp.slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await endClients(clients);
  }
}
