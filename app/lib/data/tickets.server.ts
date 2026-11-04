// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, participation, ticketRequest } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { getCampSettings } from "./camp-settings.server";
import { currentSeason } from "./participation.server";

// Stewards Sale. Campers who are Going or Leaning yes request up to the camp's ticket limit
// (camp settings) and a vehicle pass;
// Leads send the list to Burning Man, which emails each camper at their Burner profile address
// to buy their own. There's no buyer pairing or ticket tracking. Leads can lock requests
// while they finalize the list.

const conflict = (reason: string) => data({ reason }, { status: 409 });

export type RequestInput = {
  ticketsNeeded: number;
  hasTicketElsewhere: boolean;
  vehiclePassNeeded: boolean;
  note: string | null;
};

export function parseRequestForm(
  form: FormData,
  maxTickets: number,
): { input: RequestInput } | { error: string } {
  const n = Number(form.get("ticketsNeeded"));
  const elsewhere = form.get("hasTicketElsewhere") === "on";
  if (!elsewhere && !(Number.isInteger(n) && n >= 0 && n <= maxTickets)) {
    return { error: `Choose between 0 and ${maxTickets} tickets.` };
  }
  return {
    input: {
      ticketsNeeded: elsewhere ? 0 : n,
      hasTicketElsewhere: elsewhere,
      vehiclePassNeeded: form.get("vehiclePassNeeded") === "on",
      note:
        String(form.get("note") ?? "")
          .trim()
          .slice(0, 500) || null,
    },
  };
}

async function currentParticipation(db: Db, personId: string) {
  const season = await currentSeason(db);
  const [pa] = await db
    .select()
    .from(participation)
    .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)));
  return { season, pa };
}

const coming = (intent: string | null | undefined) =>
  intent === "going" || intent === "leaning_yes";

// A member's own request.
export async function getMyTickets(db: Db, personId: string) {
  const { season, pa } = await currentParticipation(db, personId);
  const [req] = pa
    ? await db.select().from(ticketRequest).where(eq(ticketRequest.participationId, pa.id))
    : [];
  return {
    locked: season.ticketRequestsLocked,
    maxTickets: (await getCampSettings(db)).maxTickets,
    canRequest: coming(pa?.intent),
    request: req
      ? {
          ticketsNeeded: req.ticketsNeeded,
          hasTicketElsewhere: req.hasTicketElsewhere,
          vehiclePassNeeded: req.vehiclePassNeeded,
          note: req.note,
          active: req.active,
        }
      : null,
  };
}

// Saves a request. Members can't once requests are locked; Leads can (bypassLock).
export async function saveTicketRequest(
  db: Db,
  actorPersonId: string,
  personId: string,
  input: RequestInput,
  { bypassLock = false } = {},
) {
  const { season, pa } = await currentParticipation(db, personId);
  if (!pa || !coming(pa.intent)) throw conflict("rsvp_first");
  if (season.ticketRequestsLocked && !bypassLock) throw conflict("requests_locked");
  const { maxTickets } = await getCampSettings(db);
  const n = input.ticketsNeeded;
  if (!Number.isInteger(n) || n < 0 || n > maxTickets) {
    throw data({ reason: "tickets_over_limit" }, { status: 400 });
  }

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(ticketRequest)
      .where(eq(ticketRequest.participationId, pa.id))
      .for("update");
    const values = { ...input, updatedByPersonId: actorPersonId, updatedAt: new Date() };
    if (before) {
      await tx.update(ticketRequest).set(values).where(eq(ticketRequest.id, before.id));
    } else {
      await tx.insert(ticketRequest).values({ participationId: pa.id, ...values });
    }

    await audit(tx, {
      actorPersonId,
      action: "ticket_request_saved",
      subjectType: "person",
      subjectId: personId,
      before: before
        ? {
            ticketsNeeded: before.ticketsNeeded,
            hasTicketElsewhere: before.hasTicketElsewhere,
            vehiclePassNeeded: before.vehiclePassNeeded,
          }
        : null,
      after: {
        ticketsNeeded: input.ticketsNeeded,
        hasTicketElsewhere: input.hasTicketElsewhere,
        vehiclePassNeeded: input.vehiclePassNeeded,
      },
    });
  });
}

export async function setRequestsLocked(db: Db, actor: Viewer, locked: boolean) {
  assertAccess(actor, "tickets");
  const season = await currentSeason(db);
  await db.update(burn).set({ ticketRequestsLocked: locked }).where(eq(burn.id, season.id));
  await audit(db, {
    actorPersonId: actor.personId,
    action: locked ? "ticket_requests_locked" : "ticket_requests_unlocked",
    subjectType: "burn",
    subjectId: season.id,
  });
}

export type RequestRow = {
  personId: string;
  name: string;
  legalName: string;
  email: string | null;
  ticketsNeeded: number | null;
  hasTicketElsewhere: boolean;
  vehiclePassNeeded: boolean;
  note: string | null;
  requested: boolean;
};

// Everyone coming this season with their active request (if any), for the Lead list.
export async function requestBoard(db: Db) {
  const season = await currentSeason(db);
  const rows = await db.execute<{
    person_id: string;
    playa_name: string | null;
    legal_name: string;
    email: string | null;
    request_id: string | null;
    tickets_needed: number | null;
    has_elsewhere: boolean | null;
    vp_needed: boolean | null;
    note: string | null;
  }>(sql`
    select p.id as person_id, p.playa_name, p.legal_name, p.email,
      r.id as request_id, r.tickets_needed, r.has_ticket_elsewhere as has_elsewhere,
      r.vehicle_pass_needed as vp_needed, r.note
    from participation pa
    join person p on p.id = pa.person_id and p.active
    left join ticket_request r on r.participation_id = pa.id and r.active
    where pa.burn_id = ${season.id} and pa.intent in ('going', 'leaning_yes')
    order by lower(coalesce(p.playa_name, p.legal_name))
  `);
  const all: RequestRow[] = rows.map((r) => ({
    personId: r.person_id,
    name: r.playa_name ?? r.legal_name,
    legalName: r.legal_name,
    email: r.email,
    ticketsNeeded: r.tickets_needed === null ? null : Number(r.tickets_needed),
    hasTicketElsewhere: r.has_elsewhere === true,
    vehiclePassNeeded: r.vp_needed === true,
    note: r.note,
    requested: r.request_id !== null,
  }));
  // Buying through the camp: at least one ticket or a vehicle pass, and no ticket elsewhere.
  const buying = all.filter(
    (r) =>
      r.requested && !r.hasTicketElsewhere && ((r.ticketsNeeded ?? 0) > 0 || r.vehiclePassNeeded),
  );
  return {
    locked: season.ticketRequestsLocked,
    maxTickets: (await getCampSettings(db)).maxTickets,
    buying,
    elsewhere: all.filter((r) => r.requested && r.hasTicketElsewhere),
    noRequest: all.filter((r) => !r.requested),
    totals: {
      tickets: buying.reduce((n, r) => n + (r.ticketsNeeded ?? 0), 0),
      vehiclePasses: buying.filter((r) => r.vehiclePassNeeded).length,
    },
  };
}

// Roster headline counts: campers asking for at least one ticket, and campers with no request.
export async function needsTicketCount(db: Db) {
  const b = await requestBoard(db);
  return {
    needsTicket: b.buying.filter((r) => (r.ticketsNeeded ?? 0) > 0).length,
    noRequest: b.noRequest.length,
  };
}
