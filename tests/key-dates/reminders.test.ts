// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  burn,
  campSettings,
  dues,
  keyDate,
  memberRole,
  participation,
  ticketRequest,
} from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Key-date reminders (R63, U19): the camp Worker's daily job emails, once, a few days before a
// date a Lead ticked, the people who haven't done its action yet.

let t: TestDb;
let z: Zulu;
let w: TestWorker;
let lead: string;
let season: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const sentSince = (n: number) =>
  w.emails
    .slice(n)
    .map((e) => e.to)
    .sort();
const remind = (label: string, action: "rsvp_by" | "tickets_close" | "dues_due", offset: number) =>
  t.db
    .insert(keyDate)
    .values({ burnId: season, label, date: day(offset), action, remind: true })
    .returning()
    .then(([d]) => d);

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  [{ id: season }] = await t.db.select({ id: burn.id }).from(burn).where(eq(burn.year, 2027));
  await t.db.update(burn).set({ duesAmountCents: 25000 }).where(eq(burn.id, season));
  const camper = async (
    name: string,
    intent: "going" | "not_going" | null,
    extra: { ticket?: boolean; paid?: boolean } = {},
  ) => {
    const p = await invitePerson(t, `${name}@example.com`, { legalName: name });
    if (!intent) return;
    const [pa] = await t.db
      .insert(participation)
      .values({ personId: p.id, burnId: season, intent })
      .returning();
    if (extra.ticket)
      await t.db.insert(ticketRequest).values({ participationId: pa.id, ticketsNeeded: 1 });
    if (extra.paid) await t.db.insert(dues).values({ participationId: pa.id, status: "paid" });
  };
  await camper("ana", null); // no RSVP
  await camper("ben", "going"); // no ticket request, dues unpaid
  await camper("cy", "going", { ticket: true, paid: true }); // all done
  await camper("dee", "going", { ticket: true }); // dues unpaid
  await camper("eve", "not_going");
  await invitePerson(t, "gus@example.com", { legalName: "Gus", active: false });
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});
beforeEach(async () => {
  await t.client`truncate key_date, send_log cascade`;
  await t.db.update(campSettings).set({ featureDues: true });
});

describe("the daily reminder job", () => {
  it("emails each ticked date's stragglers, a few days ahead, once", async () => {
    const rsvp = await remind("RSVP by", "rsvp_by", 2);
    const tickets = await remind("Ticket requests close", "tickets_close", 3);
    const due = await remind("Dues due", "dues_due", 1);
    // Too far ahead, and not ticked: neither sends.
    await remind("Later RSVP", "rsvp_by", 4);
    await t.db.insert(keyDate).values({
      burnId: season,
      label: "Not ticked",
      date: day(1),
      action: "rsvp_by",
      remind: false,
    });

    const before = w.emails.length;
    await w.scheduled();
    const sent = w.emails.slice(before);
    const to = (subject: string) =>
      sent
        .filter((e) => e.subject.includes(subject))
        .map((e) => e.to)
        .sort();
    // The lead hasn't RSVP'd either. Gus is deactivated; Eve isn't going.
    expect(to("RSVP by")).toEqual(["ana@example.com", "lead@example.com"]);
    expect(to("Ticket requests close")).toEqual(["ben@example.com"]);
    expect(to("Dues due")).toEqual(["ben@example.com", "dee@example.com"]);
    expect(
      sent.some((e) => e.subject.includes("Later RSVP") || e.subject.includes("Not ticked")),
    ).toBe(false);
    const dues = sent.find((e) => e.to === "dee@example.com");
    expect(dues?.subject).toMatch(/^Test Camp: Dues due, [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+$/);
    expect(dues?.text).toContain("aren't marked paid yet");
    expect(dues?.text).toContain("https://testcamp.themecamp.test");

    for (const d of [rsvp, tickets, due]) {
      const [row] = await t.db.select().from(keyDate).where(eq(keyDate.id, d.id));
      expect(row.remindedAt).not.toBeNull();
    }
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "key_date_reminded"), eq(auditLog.subjectId, due.id)));
    expect(audits[0].after).toMatchObject({ recipients: 2, sent: 2 });

    // A second run sends nothing more.
    const again = w.emails.length;
    await w.scheduled();
    expect(sentSince(again).filter((e) => !e.startsWith("zzb-"))).toEqual([]);
  });

  it("skips someone nudged to RSVP in the last few days", async () => {
    await t.client`
      insert into send_log (camp_id, kind, recipient, status, created_at)
      values (${t.campId}, 'rsvp_nudge', 'ana@example.com', 'sent', now() - interval '1 day')`;
    await remind("RSVP by", "rsvp_by", 2);
    const before = w.emails.length;
    await w.scheduled();
    expect(sentSince(before).filter((e) => !e.startsWith("zzb-"))).toEqual(["lead@example.com"]);
  });

  it("holds a dues date while dues are switched off, and sends it once they're back on", async () => {
    const d = await remind("Dues due", "dues_due", 2);
    await t.db.update(campSettings).set({ featureDues: false });
    let before = w.emails.length;
    await w.scheduled();
    expect(sentSince(before).filter((e) => !e.startsWith("zzb-"))).toEqual([]);
    const [held] = await t.db.select().from(keyDate).where(eq(keyDate.id, d.id));
    expect(held.remindedAt).toBeNull();
    await t.db.update(campSettings).set({ featureDues: true });
    before = w.emails.length;
    await w.scheduled();
    expect(sentSince(before).filter((e) => !e.startsWith("zzb-"))).toEqual([
      "ben@example.com",
      "dee@example.com",
    ]);
  });

  it("reminds again when a reminded date moves to a new day", async () => {
    const d = await remind("RSVP by", "rsvp_by", 2);
    await w.scheduled();
    const res = await w.fetch(
      post(
        "/dates",
        {
          intent: "edit",
          id: d.id,
          label: "RSVP by",
          date: day(3),
          action: "rsvp_by",
          remind: "on",
        },
        { cookie: lead },
      ),
    );
    expect(res.status).toBe(302);
    await res.text();
    const [moved] = await t.db.select().from(keyDate).where(eq(keyDate.id, d.id));
    expect(moved.remindedAt).toBeNull();
    expect(moved.remind).toBe(true);
  });

  it("only saves the reminder tick on a date tied to something", async () => {
    await (
      await w.fetch(
        post(
          "/dates",
          { intent: "add", label: "Build day", date: day(10), action: "", remind: "on" },
          { cookie: lead },
        ),
      )
    ).text();
    const [d] = await t.db.select().from(keyDate).where(eq(keyDate.label, "Build day"));
    expect(d.remind).toBe(false);
    const html = await (await w.fetch(get("/dates", lead))).text();
    expect(html).toContain("Email a reminder 3 days before");
  });

  it("keeps each camp's reminders to its own people, with its own address", async () => {
    await t.client`update burn set dues_amount_cents = 10000 where camp_id = ${z.campId}`;
    await t.client`update camp_settings set feature_dues = true where camp_id = ${z.campId}`;
    const [zSeason] = await t.client<Array<{ id: string }>>`
      select id from burn where camp_id = ${z.campId} and year = 2027`;
    await t.client`
      insert into key_date (camp_id, burn_id, label, date, action, remind)
      values (${z.campId}, ${zSeason.id}, 'Zulu dues', ${day(2)}, 'dues_due', true)`;
    await remind("Dues due", "dues_due", 2);
    const before = w.emails.length;
    await w.scheduled();
    const sent = w.emails.slice(before);
    const zulu = sent.filter((e) => e.subject.includes("Zulu dues"));
    expect(zulu.map((e) => e.to)).toEqual(["zzb-member@example.com"]);
    expect(zulu[0].text).toContain(".themecamp.test");
    expect(zulu[0].text).not.toContain("testcamp.themecamp.test");
    const ours = sent.filter((e) => e.subject.startsWith("Test Camp:"));
    expect(ours.map((e) => e.to).sort()).toEqual(["ben@example.com", "dee@example.com"]);
  });
});
