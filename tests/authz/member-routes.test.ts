// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, memberRole, participation, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let leadCookie: string;
let aliceCookie: string;
let aliceId: string;
let bobId: string;

async function intentOf(personId: string) {
  const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  const [row] = await t.db
    .select()
    .from(participation)
    .where(and(eq(participation.personId, personId), eq(participation.burnId, season.id)));
  return row;
}

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  const lead = await invitePerson(t, "lead@example.com", { playaName: "Captain" });
  await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
  leadCookie = await signIn(w, "lead@example.com");
  aliceId = (
    await invitePerson(t, "alice@example.com", { legalName: "Alice A", playaName: "Sparkle" })
  ).id;
  aliceCookie = await signIn(w, "alice@example.com");
  bobId = (await invitePerson(t, "bob@example.com", { legalName: "Bob B", phone: "5551112222" }))
    .id;
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("member RSVP and profile through the real Worker", () => {
  it("prompts for an RSVP on home, then saves the member's own RSVP", async () => {
    expect(await (await w.fetch(get("/", aliceCookie))).text()).toContain("RSVP for 2027");

    const res = await w.fetch(
      post(
        "/rsvp",
        { intent: "going", arrivalDate: "2027-08-28", generator: "yes" },
        { cookie: aliceCookie },
      ),
    );
    expect(res.status).toBe(302);
    expect(await intentOf(aliceId)).toMatchObject({
      intent: "going",
      generator: true,
      updatedByPersonId: aliceId,
    });
    expect(await (await w.fetch(get("/", aliceCookie))).text()).toContain("Update RSVP");
  });

  it("only ever edits the signed-in person's profile, whatever the form says", async () => {
    await w.fetch(
      post("/profile", { legalName: "Alice Updated", personId: bobId }, { cookie: aliceCookie }),
    );
    const [alice] = await t.db.select().from(person).where(eq(person.id, aliceId));
    const [bob] = await t.db.select().from(person).where(eq(person.id, bobId));
    expect(alice.legalName).toBe("Alice Updated");
    expect(bob.legalName).toBe("Bob B");
  });

  it("refuses a Member editing someone else's RSVP via the Lead page", async () => {
    const res = await w.fetch(
      post(`/people/${bobId}/rsvp`, { intent: "not_going" }, { cookie: aliceCookie }),
    );
    expect(res.status).toBe(403);
    expect(await intentOf(bobId)).toBeUndefined();
  });

  it("lets a Lead RSVP for someone, and the member sees who did it", async () => {
    const res = await w.fetch(
      post(`/people/${bobId}/rsvp`, { intent: "leaning_yes" }, { cookie: leadCookie }),
    );
    expect(res.status).toBe(302);
    expect(await intentOf(bobId)).toMatchObject({ intent: "leaning_yes" });

    const bobCookie = await signIn(w, "bob@example.com");
    const html = await (await w.fetch(get("/", bobCookie))).text();
    expect(html).toContain("Updated by Captain");
  });

  it("doesn't leak other members' details on the member pages", async () => {
    for (const path of ["/", "/rsvp", "/profile"]) {
      const html = await (await w.fetch(get(path, aliceCookie))).text();
      expect(html).not.toContain("5551112222");
      expect(html).not.toContain("bob@example.com");
    }
  });

  it("saves a ticket request only for the signed-in member", async () => {
    const res = await w.fetch(
      post("/tickets/request", { ticketsNeeded: "2", personId: bobId }, { cookie: aliceCookie }),
    );
    expect(res.status).toBe(302);
    const rows =
      await t.client`select tr.tickets_needed, pa.person_id from ticket_request tr join participation pa on pa.id = tr.participation_id`;
    expect(rows.map((r) => r.person_id)).toEqual([aliceId]);
    expect(await (await w.fetch(get("/", aliceCookie))).text()).toContain("Requested: 2 ticket(s)");
  });
});
