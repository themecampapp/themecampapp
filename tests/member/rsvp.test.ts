// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, burn, dues, participation, person, ticketRequest } from "~/db/schema";
import { getRsvp, parseRsvpForm, type RsvpInput, saveRsvp } from "~/lib/data/participation.server";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate person, participation, ticket_request, dues, audit_log cascade`;
});

const blank: RsvpInput = {
  intent: null,
  arrivalDate: null,
  departureDate: null,
  sapRequested: null,
  sapDate: null,
  dwellingDescription: null,
  dwellingSize: null,
  generator: null,
};

async function makePerson(name: string, playa?: string) {
  const [p] = await t.db
    .insert(person)
    .values({ legalName: name, playaName: playa ?? null })
    .returning();
  return p;
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("parseRsvpForm", () => {
  it("treats blank logistics as unknown, not no", () => {
    const r = parseRsvpForm(form({ intent: "going", generator: "", sapRequested: "no" }));
    expect(r).toMatchObject({
      input: { intent: "going", generator: null, sapRequested: false, arrivalDate: null },
    });
  });

  it("keeps the SAP day only with a request for a Setup Access Pass", () => {
    const yes = parseRsvpForm(
      form({ intent: "going", sapRequested: "yes", sapDate: "2027-08-21" }),
    );
    expect(yes).toMatchObject({ input: { sapRequested: true, sapDate: "2027-08-21" } });
    for (const answer of ["no", ""]) {
      const r = parseRsvpForm(
        form({ intent: "going", sapRequested: answer, sapDate: "2027-08-21" }),
      );
      expect(r).toMatchObject({ input: { sapDate: null } });
    }
    const bad = parseRsvpForm(form({ intent: "going", sapRequested: "yes", sapDate: "soon" }));
    expect(bad).toMatchObject({ input: { sapRequested: true, sapDate: null } });
  });

  it("rejects departure before arrival and unknown intents", () => {
    expect(
      parseRsvpForm(
        form({ intent: "going", arrivalDate: "2027-08-30", departureDate: "2027-08-28" }),
      ),
    ).toEqual({
      error: "Departure can't be before arrival.",
    });
    expect(parseRsvpForm(form({ intent: "maybe" }))).toEqual({
      error: "Pick one of the RSVP options.",
    });
  });
});

describe("saveRsvp", () => {
  it("creates the 2027 participation and audits the member as actor", async () => {
    const p = await makePerson("Member");
    await saveRsvp(t.db, p.id, p.id, {
      ...blank,
      intent: "going",
      arrivalDate: "2027-08-28",
      generator: true,
    });

    const rsvp = await getRsvp(t.db, p.id);
    expect(rsvp).toMatchObject({
      intent: "going",
      arrivalDate: "2027-08-28",
      generator: true,
      sapDate: null,
      updatedByOther: null,
    });
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, "rsvp_updated"));
    expect(a.actorPersonId).toBe(p.id);
  });

  it("shows a Lead's edit to the member, and the member's later edit wins", async () => {
    const member = await makePerson("Member");
    const lead = await makePerson("Lead Person", "Captain");
    await saveRsvp(t.db, lead.id, member.id, { ...blank, intent: "leaning_yes" });
    expect((await getRsvp(t.db, member.id))?.updatedByOther).toBe("Captain");

    await saveRsvp(t.db, member.id, member.id, { ...blank, intent: "going" });
    const rsvp = await getRsvp(t.db, member.id);
    expect(rsvp).toMatchObject({ intent: "going", updatedByOther: null });
    const actors = (await t.db.select().from(auditLog)).map((a) => a.actorPersonId).sort();
    expect(actors).toEqual([lead.id, member.id].sort());
  });

  it("switching to Not going withdraws the ticket request and flags paid dues", async () => {
    const member = await makePerson("Member");
    await saveRsvp(t.db, member.id, member.id, { ...blank, intent: "going" });
    const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    const [pa] = await t.db
      .select()
      .from(participation)
      .where(and(eq(participation.personId, member.id), eq(participation.burnId, season.id)));
    await t.db.insert(ticketRequest).values({ participationId: pa.id, ticketsNeeded: 2 });
    await t.db.insert(dues).values({ participationId: pa.id, status: "paid", amountCents: 20000 });

    await saveRsvp(t.db, member.id, member.id, { ...blank, intent: "not_going" });

    expect((await t.db.select().from(ticketRequest))[0].active).toBe(false);
    expect((await t.db.select().from(dues))[0]).toMatchObject({ status: "paid", flagged: true });

    await saveRsvp(t.db, member.id, member.id, { ...blank, intent: "leaning_yes" });
    expect((await t.db.select().from(ticketRequest))[0].active).toBe(true);
  });
});
