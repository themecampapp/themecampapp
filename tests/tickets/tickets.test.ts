// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, person } from "~/db/schema";
import type { Viewer } from "~/lib/access.server";
import { saveRsvp } from "~/lib/data/participation.server";
import {
  getMyTickets,
  needsTicketCount,
  requestBoard,
  saveTicketRequest,
  setRequestsLocked,
} from "~/lib/data/tickets.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { asRoles } from "../helpers/viewer";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, participation, ticket_request, audit_log cascade`;
  await t.client`update burn set ticket_requests_locked = false`;
});

const blankRsvp = {
  arrivalDate: null,
  departureDate: null,
  sapRequested: null,
  sapDate: null,
  dwellingDescription: null,
  dwellingSize: null,
  generator: null,
};

async function camper(
  name: string,
  intent: "going" | "leaning_yes" | "not_going" | null = "going",
) {
  const [p] = await t.db.insert(person).values({ legalName: name, playaName: name }).returning();
  if (intent) await saveRsvp(t.db, p.id, p.id, { ...blankRsvp, intent });
  return p;
}

async function lead(): Promise<Viewer> {
  const p = await camper("Lead", null);
  return {
    personId: p.id,
    authUserId: "x",
    legalName: "Lead",
    playaName: "Lead",
    ...asRoles(["lead"]),
  };
}

const want = (n: number, extra: Partial<Parameters<typeof saveTicketRequest>[3]> = {}) => ({
  ticketsNeeded: n,
  hasTicketElsewhere: false,
  vehiclePassNeeded: false,
  note: null,
  ...extra,
});

const reason = (e: unknown) => (e as { data?: { reason?: string } })?.data?.reason;

describe("member requests", () => {
  it("saves a request for someone coming, and shows it as requested (not as a ticket)", async () => {
    const p = await camper("Ada");
    await saveTicketRequest(t.db, p.id, p.id, want(2, { vehiclePassNeeded: true }));
    const mine = await getMyTickets(t.db, p.id);
    expect(mine.request).toMatchObject({ ticketsNeeded: 2, vehiclePassNeeded: true });
    expect(mine).not.toHaveProperty("tickets");
  });

  it("requires an RSVP of Going or Leaning yes", async () => {
    const out = await camper("Out", "not_going");
    const none = await camper("None", null);
    expect(reason(await saveTicketRequest(t.db, out.id, out.id, want(1)).catch((e) => e))).toBe(
      "rsvp_first",
    );
    expect(reason(await saveTicketRequest(t.db, none.id, none.id, want(1)).catch((e) => e))).toBe(
      "rsvp_first",
    );
  });

  it("refuses member edits once locked, but lets a Lead record on their behalf", async () => {
    const actor = await lead();
    const p = await camper("Late");
    await setRequestsLocked(t.db, actor, true);
    expect(reason(await saveTicketRequest(t.db, p.id, p.id, want(1)).catch((e) => e))).toBe(
      "requests_locked",
    );
    await saveTicketRequest(t.db, actor.personId, p.id, want(1), { bypassLock: true });
    expect((await getMyTickets(t.db, p.id)).request?.ticketsNeeded).toBe(1);
  });
});

describe("the Leads' request list", () => {
  it("lists who's buying through the camp, with emails and totals", async () => {
    const a = await camper("Ada");
    await t.db
      .update(person)
      .set({ legalName: "Ada Lovelace", email: "ada@example.com" })
      .where(eq(person.id, a.id));
    const b = await camper("Bo", "leaning_yes");
    const vpOnly = await camper("Vee");
    const zero = await camper("Zed");
    await saveTicketRequest(t.db, a.id, a.id, want(2, { vehiclePassNeeded: true }));
    await saveTicketRequest(t.db, b.id, b.id, want(1));
    await saveTicketRequest(t.db, vpOnly.id, vpOnly.id, want(0, { vehiclePassNeeded: true }));
    await saveTicketRequest(t.db, zero.id, zero.id, want(0));

    const board = await requestBoard(t.db);
    expect(board.buying.map((r) => [r.name, r.ticketsNeeded, r.vehiclePassNeeded])).toEqual([
      ["Ada", 2, true],
      ["Bo", 1, false],
      ["Vee", 0, true],
    ]);
    expect(board.buying[0]).toMatchObject({ legalName: "Ada Lovelace", email: "ada@example.com" });
    expect(board.totals).toEqual({ tickets: 3, vehiclePasses: 2 });
    expect(await needsTicketCount(t.db)).toEqual({ needsTicket: 2, noRequest: 0 });
  });

  it("separates campers with a ticket elsewhere and those who haven't answered", async () => {
    const e = await camper("Else");
    await camper("Quiet");
    await camper("Away", "not_going");
    await saveTicketRequest(t.db, e.id, e.id, want(0, { hasTicketElsewhere: true }));
    const board = await requestBoard(t.db);
    expect(board.buying).toHaveLength(0);
    expect(board.elsewhere.map((r) => r.name)).toEqual(["Else"]);
    expect(board.noRequest.map((r) => r.name)).toEqual(["Quiet"]);
    expect(await needsTicketCount(t.db)).toEqual({ needsTicket: 0, noRequest: 1 });
  });

  it("drops a camper who switches to Not going, and restores them when they come back", async () => {
    const p = await camper("Flip");
    await saveTicketRequest(t.db, p.id, p.id, want(2));
    await saveRsvp(t.db, p.id, p.id, { ...blankRsvp, intent: "not_going" });
    expect((await requestBoard(t.db)).buying).toHaveLength(0);
    await saveRsvp(t.db, p.id, p.id, { ...blankRsvp, intent: "going" });
    expect((await requestBoard(t.db)).buying.map((r) => r.name)).toEqual(["Flip"]);
  });

  it("audits requests and the lock", async () => {
    const actor = await lead();
    const p = await camper("Ada");
    await saveTicketRequest(t.db, p.id, p.id, want(1));
    await setRequestsLocked(t.db, actor, true);
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["ticket_request_saved", "ticket_requests_locked"]),
    );
  });
});
