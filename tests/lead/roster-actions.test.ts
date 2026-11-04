// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, burn, memberRole, participation, sendLog } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// The Lead workspace plan, Unit 8: acting on the people picked on the Roster (RSVP nudges with
// a preview) and exporting the Roster view.

let t: TestDb;
let z: Zulu;
let w: TestWorker;
let lead: string;
let treasurer: string;
let season: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead", playaName: "Lee" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  const tr = await invitePerson(t, "tia@example.com", { legalName: "Tia Treasurer" });
  await t.db.insert(memberRole).values([
    { personId: tr.id, role: "lead" },
    { personId: tr.id, role: "treasurer" },
  ]);
  lead = await signIn(w, "lead@example.com");
  treasurer = await signIn(w, "tia@example.com");
  await w.fetch(get("/", lead));
  await w.fetch(get("/", treasurer));
  [{ id: season }] = await t.db.select({ id: burn.id }).from(burn).where(eq(burn.year, 2027));
  for (const name of ["Ana", "Ben", "Cy", "Dee"]) {
    const p = await invitePerson(t, `${name.toLowerCase()}@example.com`, {
      legalName: `${name} Camper`,
      playaName: name,
    });
    ids[name] = p.id;
  }
  // Cy has RSVP'd; Ben was nudged yesterday.
  await t.db.insert(participation).values({ personId: ids.Cy, burnId: season, intent: "going" });
  await t.client`
    insert into send_log (camp_id, kind, recipient, status, created_at)
    values (${t.campId}, 'rsvp_nudge', 'ben@example.com', 'sent', now() - interval '1 day')`;
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

const nudge = (picked: string[], intent?: "send") =>
  w.fetch(
    post(
      "/roster/nudge",
      [
        ...(intent ? ([["intent", intent]] as Array<[string, string]>) : []),
        ["search", "?preset=no-rsvp"],
        ...picked.map((id) => ["id", id] as [string, string]),
      ],
      { cookie: lead },
    ),
  );
const section = (html: string, heading: string) => {
  const at = html.indexOf(heading);
  return at < 0 ? "" : html.slice(at, at + 600);
};

describe("RSVP nudges to the people picked", () => {
  it("previews who'll be emailed, who's skipped, and why, before sending anything", async () => {
    const before = w.emails.length;
    const html = await (await nudge([ids.Ana, ids.Ben, ids.Cy, z.memberId])).text();
    expect(section(html, "Will be emailed (1)")).toContain("Ana");
    expect(section(html, "Skipped: nudged in the last 3 days (1)")).toContain("Ben");
    // Cy (RSVP'd) isn't on the No RSVP view, and Zulu's person isn't in this camp at all:
    // neither is mentioned.
    expect(html).not.toContain(">Cy<");
    expect(html).not.toContain("Cy, ");
    expect(html).not.toMatch(/Zzb/);
    // The email, as it'll be sent.
    expect(html).toContain("Are you coming to Test Camp in 2027?");
    expect(w.emails.length).toBe(before);
  });

  it("sends only to the eligible people picked, and audits it once", async () => {
    const before = w.emails.length;
    const res = await nudge([ids.Ana, ids.Ben, ids.Dee, z.memberId], "send");
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("Sent 2 RSVP nudges.");
    await res.text();
    expect(
      w.emails
        .slice(before)
        .map((e) => e.to)
        .sort(),
    ).toEqual(["ana@example.com", "dee@example.com"]);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "rsvp_nudge_sent"), eq(auditLog.campId, t.campId)));
    expect(audits).toHaveLength(1);
    expect((audits[0].after as { personIds: string[] }).personIds.sort()).toEqual(
      [ids.Ana, ids.Dee].sort(),
    );
  });

  it("doesn't email someone who RSVP'd between the preview and Send", async () => {
    await t.client`delete from send_log where kind = 'rsvp_nudge'`;
    const preview = await (await nudge([ids.Dee])).text();
    expect(section(preview, "Will be emailed (1)")).toContain("Dee");
    await t.db.insert(participation).values({ personId: ids.Dee, burnId: season, intent: "going" });
    const before = w.emails.length;
    const res = await nudge([ids.Dee], "send");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("Sent 0 RSVP nudges.");
    await res.text();
    expect(w.emails.length).toBe(before);
  });

  it("puts the ticks and actions on the roster", async () => {
    const html = await (await w.fetch(get("/roster?preset=no-rsvp", lead))).text();
    expect(html).toContain('form="roster-selection"');
    expect(html).toContain('action="/roster/nudge"');
    expect(html).toContain('href="/roster/export?preset=no-rsvp"');
  });
});

describe("exporting a Roster view", () => {
  const csv = async (search: string, cookie = lead) => {
    const res = await w.fetch(get(`/roster/export${search}`, cookie));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("testcamp-roster-");
    return (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
  };

  it("has exactly the view's people and columns, and is audited", async () => {
    const lines = await csv("?preset=no-rsvp&cols=rsvp");
    expect(lines[0]).toBe("Name,Playa name,Email,Phone,RSVP");
    expect(
      lines
        .slice(1)
        .map((l) => l.split(",")[0])
        .sort(),
      // Dee RSVP'd above; the two Leads haven't.
    ).toEqual(["Ana Camper", "Ben Camper", "Lee Lead", "Tia Treasurer"]);
    const [a] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "roster_exported"), eq(auditLog.campId, t.campId)));
    expect(a.after).toMatchObject({ rows: 4, dues: false });
  });

  it("leaves dues out for a Lead who isn't the Treasurer, and in for the Treasurer", async () => {
    expect((await csv("?cols=rsvp,dues"))[0]).not.toContain("Dues");
    expect((await csv("?cols=rsvp,dues", treasurer))[0]).toContain("Dues");
  });

  it("never includes another camp's people", async () => {
    const lines = await csv("?preset=everyone");
    expect(lines.join("\n")).not.toMatch(/Zzb|zzb-/);
  });
});
