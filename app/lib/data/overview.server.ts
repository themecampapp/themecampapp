// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { count, eq } from "drizzle-orm";
import { inquiry, leadQueueItem } from "~/db/schema";
import { can, type Viewer } from "../access.server";
import type { Db } from "../db.server";
import type { Features } from "../features";
import { seasonCounts, seasonRows } from "./season-roster.server";
import { listRoles } from "./volunteer.server";

// The Lead home's Overview (Lead workspace plan, Unit 7): what the camp needs now, each item
// linking to exactly its list. Only items with something to do are returned; dues only for a
// Treasurer, and each feature's item only while it's switched on.
export async function campOverview(db: Db, viewer: Viewer, features: Features) {
  const treasurer = can(viewer, "dues") && features.dues;
  const counts = seasonCounts(await seasonRows(db, { dues: treasurer, contact: false }), treasurer);
  const n = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const items: Array<{ key: string; label: string; to: string; n: number }> = [
    {
      key: "no-rsvp",
      n: counts.noRsvp,
      label: `${plural(counts.noRsvp, "person", "people")} invited, no RSVP yet`,
      to: "/roster?preset=no-rsvp",
    },
    {
      key: "missing-ticket",
      n: counts.missingTicket,
      label: `${plural(counts.missingTicket, "camper", "campers")} coming without a ticket request`,
      to: "/tickets?show=missing",
    },
  ];
  if (features.saps) {
    items.push({
      key: "pending-sap",
      n: counts.pendingSap,
      label: `${plural(counts.pendingSap, "SAP request", "SAP requests")} to decide`,
      to: "/saps",
    });
  }
  if (features.join) {
    const k = await n(db.select({ n: count() }).from(inquiry).where(eq(inquiry.status, "new")));
    items.push({
      key: "inquiries",
      n: k,
      label: `${plural(k, "new inquiry", "new inquiries")}`,
      to: "/inquiries?status=new",
    });
  }
  const queue = await n(
    db.select({ n: count() }).from(leadQueueItem).where(eq(leadQueueItem.status, "open")),
  );
  items.push({
    key: "queue",
    n: queue,
    label: `${plural(queue, "problem", "problems")} in the Queue`,
    to: "/queue",
  });
  if (features.volunteer) {
    const roles = await listRoles(db, viewer.personId);
    const open = roles.reduce((k, r) => k + Math.max(0, r.slots - r.signups.length), 0);
    items.push({
      key: "volunteer",
      n: open,
      label: `${plural(open, "open spot", "open spots")} in jobs`,
      to: "/volunteers",
    });
  }
  if (treasurer && counts.unpaid !== null) {
    items.push({
      key: "unpaid",
      n: counts.unpaid,
      label: `${plural(counts.unpaid, "camper", "campers")} coming with dues unpaid`,
      to: "/roster?preset=unpaid",
    });
  }
  return items.filter((i) => i.n > 0).map(({ key, label, to }) => ({ key, label, to }));
}
