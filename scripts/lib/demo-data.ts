// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { DEMO_ADMIN_ID, DEMO_LEAD_ID, DEMO_MEMBER_ID } from "~/lib/demo";
import { NO_ACCESS } from "~/lib/permissions";
import { parseStarter } from "~/lib/starter-guide";
import { readConfig } from "../config-to-wrangler";

// R67: the demo camp's fictional data. Resets the camp: whatever was in it goes, and a fresh
// copy is made, with dates relative to `now` so it always looks current. Runs as the database
// owner (scripts/seed-demo.ts) and in tests. It refuses to touch a camp that isn't a demo.

type Sql = postgres.Sql;

// Made up. Any likeness to a real burner is a coincidence.
export const PEOPLE: Array<[legal: string, playa: string]> = [
  ["Rowan Vale", "Compass"],
  ["Juniper Hale", "Sprocket"],
  ["Theo Marsh", "Dust Bunny"],
  ["Priya Castellan", "Firefly"],
  ["Omar Reyes-Lind", "Wrench"],
  ["Hazel Okafor", "Lantern"],
  ["Felix Aldana", "Moth"],
  ["Mara Quill", "Teacup"],
  ["Desmond Frye", "Tumbleweed"],
  ["Ines Varga", "Sundial"],
  ["Caleb Northcott", "Gizmo"],
  ["Nadia Sorensen", "Kite"],
  ["Wes Tamura", "Pickle"],
  ["Lena Duarte", "Marigold"],
  ["Silas Brandt", "Anvil"],
  ["Ada Kowal", "Ember"],
  ["Jonah Pike", "Biscuit"],
  ["Rosa Iyer", "Cactus"],
  ["Emeric Stone", "Glider"],
  ["Tess Morrow", "Sparkplug"],
  ["Kai Whitlock", "Driftwood"],
  ["Gemma Faro", "Nova"],
  ["Arlo Benedict", "Pepper"],
  ["Yara Solis", "Glow"],
  ["Hugo Lindqvist", "Tinker"],
  ["Pia Moreau", "Zephyr"],
  ["Bram Ellery", "Ratchet"],
  ["Noor Haddad", "Wisp"],
  ["Otis Crane", "Sherpa"],
  ["Lucia Ferro", "Saffron"],
];
// The people a demo visitor can be (app/lib/demo.ts): Compass the Lead, Sprocket the Admin, and
// Lantern, a member who's coming with dues still to pay.
const STABLE_IDS: Record<number, string> = { 0: DEMO_LEAD_ID, 1: DEMO_ADMIN_ID, 5: DEMO_MEMBER_ID };

const INTENTS = [
  ...Array(14).fill("going"),
  ...Array(5).fill("leaning_yes"),
  ...Array(3).fill("leaning_no"),
  ...Array(2).fill("not_going"),
  ...Array(6).fill(null),
] as Array<string | null>;
const HOMES = [
  "Oakland, CA",
  "Reno, NV",
  "Portland, OR",
  "Denver, CO",
  "Austin, TX",
  "Seattle, WA",
];

// Dates go in as ISO text: the tests share their client with drizzle, which turns off
// postgres.js's own Date handling.
const day = (d: Date) => d.toISOString().slice(0, 10);
const plus = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000);
const email = (legal: string) => `${legal.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

// The starter guides, with {product} filled in as the hosted service's name (the demo camp is
// the hosted service's).
function starters() {
  const dir = fileURLToPath(new URL("../../content/starter-guides/", import.meta.url));
  const product = readConfig("hosted").product.name;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseStarter(f, readFileSync(join(dir, f), "utf8")))
    .map((g) => ({ ...g, body: g.body.replaceAll("{product}", product) }));
}

// The demo's files have fixed keys under the camp's own prefix, and the camp keeps its id
// across resets, so each reset overwrites the same objects and never leaves any behind.
const fixed = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const hasPhoto = (i: number) => i % 5 !== 4;
export const photoKey = (campId: string, i: number) =>
  `camps/${campId}/p/${fixed(0xd0000 + i)}.webp`;
export const samplePassKey = (campId: string) => `camps/${campId}/sap/${fixed(0xd5a90)}.pdf`;
export const logoKey = (campId: string) => `camps/${campId}/logo/${fixed(0xd1060)}.webp`;

// Mirage Camp's own look (issue #64), so the demo doesn't wear the platform's default gold
// balloon: an oasis turquoise (dark text on it is 8.2:1) and, with its files, a sun-and-
// shimmer logo (scripts/lib/demo-files.ts).
export const DEMO_ACCENT = "#2ec4b6";

// `withFiles`: point people's photos and one SAP pass at the demo's files. Only when they're
// uploaded too (scripts/seed-demo.ts --bucket), or the pages would show broken images.
export async function resetDemoCamp(
  sql: Sql,
  {
    slug = "demo",
    name = "Mirage Camp",
    now = new Date(),
    withFiles = false,
  }: { slug?: string; name?: string; now?: Date; withFiles?: boolean } = {},
): Promise<string> {
  // The season being planned: next year's from September on, like a new camp's.
  const year = now.getUTCMonth() >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return (await sql.begin(async (tx) => {
    const [old] = await tx<{ id: string; kind: string }[]>`
      select id, kind from camp where slug = ${slug}`;
    if (old) {
      if (old.kind !== "demo") throw new Error(`${slug} is a real camp: refusing to reset it`);
      // The deletion guard only lets a camp marked for deletion go.
      await tx`
        update camp set status = 'pending_deletion', delete_after = now() - interval '1 second'
        where id = ${old.id}`;
      await tx`delete from camp where id = ${old.id}`;
    }
    const [c] = await tx<{ id: string }[]>`
      insert into camp (id, slug, name, kind)
      values (${old?.id ?? crypto.randomUUID()}, ${slug}, ${name}, 'demo') returning id`;
    await tx`select set_config('app.camp_id', ${c.id}, true)`;

    const seasons: Record<number, string> = {};
    for (const y of [year - 2, year - 1, year]) {
      const sapDays = y === year ? [20, 21, 22, 23, 24].map((d) => `${y}-08-${d}`) : [];
      const [b] = await tx<{ id: string }[]>`
        insert into burn (year, dues_amount_cents, payment_instructions, sap_days)
        values (${y}, ${y === year ? 25000 : 22500}, ${"Venmo @mirage-camp or cash at a camp meetup."},
          ${JSON.stringify(sapDays)}::text::jsonb)
        returning id`;
      seasons[y] = b.id;
    }
    await tx`
      insert into camp_settings (current_year, contact_email, feature_saps,
        feature_volunteer, inquiry_notify, accent, logo_key)
      values (${year}, 'hello@example.com', true, true,
        ${JSON.stringify(["hello@example.com"])}::text::jsonb, ${DEMO_ACCENT},
        ${withFiles ? logoKey(c.id) : null})`;
    // The join page's intro, as the camp's page wording (app/lib/page-text.ts).
    await tx`
      insert into app_setting (key, value)
      values ('page_text:join_intro', ${JSON.stringify(
        "We're a friendly camp of builders, bakers and night owls. Say hello! Tell us a little about yourself and a camp lead will reach out to say hello.",
      )}::text::jsonb)`;

    const ids: string[] = [];
    for (const [i, [legal, playa]] of PEOPLE.entries()) {
      const [p] = await tx<{ id: string }[]>`
        insert into person (id, legal_name, playa_name, email, phone, home_location,
          directory_choice_seen_at, directory_hidden, privacy_notice_seen_at, photo_key,
          photo_updated_at)
        values (${STABLE_IDS[i] ?? crypto.randomUUID()}, ${legal}, ${playa}, ${email(legal)},
          ${`555-555-01${String(i).padStart(2, "0")}`}, ${HOMES[i % HOMES.length]}, now(),
          ${i % 4 === 3}, now(), ${withFiles && hasPhoto(i) ? photoKey(c.id, i) : null},
          ${withFiles && hasPhoto(i) ? now.toISOString() : null})
        returning id`;
      ids.push(p.id);
      await tx`
        insert into invite (person_id, email, status, sent_at)
        values (${p.id}, ${email(legal)}, 'pending', ${plus(now, -40 + i).toISOString()})`;
    }
    const [lead, admin, treasurer, lead2] = ids;
    await tx`
      insert into member_role (person_id, role) values
        (${lead}, 'lead'), (${admin}, 'admin'), (${admin}, 'lead'), (${treasurer}, 'treasurer'),
        (${treasurer}, 'lead'), (${lead2}, 'lead')`;
    // Issue #93: a custom role, so the Admin view shows one, held by a camper who isn't a Lead.
    const [coordinator] = await tx<{ id: string }[]>`
      insert into camp_role (name, description, grants)
      values ('Tickets coordinator', 'Keeps track of the Stewards Sale ticket requests.',
        ${JSON.stringify({ ...NO_ACCESS, tickets: "manage" })}::text::jsonb)
      returning id`;
    await tx`
      insert into member_role (person_id, role, custom_role_id)
      values (${ids[6]}, 'custom', ${coordinator.id})`;

    // Past years: most came last year, fewer the year before.
    for (const [i, id] of ids.entries()) {
      if (i < 20)
        await tx`insert into participation (person_id, burn_id, intent, attended)
          values (${id}, ${seasons[year - 1]}, 'going', true)`;
      if (i < 12)
        await tx`insert into participation (person_id, burn_id, intent, attended)
          values (${id}, ${seasons[year - 2]}, 'going', true)`;
    }

    // This season: RSVPs, tickets, dues, SAP requests.
    const thisSeason: string[] = [];
    for (const [i, id] of ids.entries()) {
      const intent = INTENTS[i];
      if (!intent) continue;
      const coming = intent === "going" || intent === "leaning_yes";
      const [pa] = await tx<{ id: string }[]>`
        insert into participation (person_id, burn_id, intent, arrival_date, departure_date,
          sap_requested, sap_date, dwelling_description, dwelling_size, generator, updated_by_person_id)
        values (${id}, ${seasons[year]}, ${intent},
          ${coming ? `${year}-08-${String(21 + (i % 6)).padStart(2, "0")}` : null},
          ${coming ? `${year}-09-0${1 + (i % 2)}` : null},
          ${i < 4 && intent === "going"}, ${i < 4 && intent === "going" ? `${year}-08-2${i}` : null},
          ${coming ? ["Tent", "Shiftpod", "Van", "RV"][i % 4] : null},
          ${coming ? ["10 x 10 ft", "12 x 12 ft", "8 x 18 ft", "10 x 30 ft"][i % 4] : null},
          ${coming && i % 7 === 0}, ${id})
        returning id`;
      thisSeason[i] = pa.id;
      if (coming && i % 5 !== 4) {
        await tx`
          insert into ticket_request (participation_id, tickets_needed, has_ticket_elsewhere,
            vehicle_pass_needed, updated_by_person_id)
          values (${pa.id}, ${i % 3 === 0 ? 2 : 1}, ${i % 9 === 8}, ${i % 4 === 1}, ${id})`;
      }
      if (intent === "going") {
        const paid = i % 2 === 0;
        await tx`
          insert into dues (participation_id, status, amount_cents, paid_on, method, updated_by_person_id)
          values (${pa.id}, ${paid ? "paid" : i === 13 ? "waived" : "unpaid"},
            ${paid ? 25000 : null}, ${paid ? day(plus(now, -10 - i)) : null},
            ${paid ? "venmo" : null}, ${treasurer})`;
      }
    }

    // SAP passes, so both kinds of decision show: Compass approved with a pass and its PDF,
    // Sprocket approved with a pass, and two still to decide, one on a day with no passes left.
    const passes: Record<string, string> = {};
    for (const [serial, d] of [
      ["DEMO-0001", 20],
      ["DEMO-0002", 20],
      ["DEMO-0003", 21],
      ["DEMO-0004", 21],
    ] as const) {
      const [pass] = await tx<{ id: string }[]>`
        insert into sap_pass (burn_id, valid_date, serial) values (${seasons[year]}, ${`${year}-08-${d}`}, ${serial})
        returning id`;
      passes[serial] = pass.id;
    }
    for (const [i, serial, withPdf] of [
      [0, "DEMO-0001", true],
      [1, "DEMO-0003", false],
    ] as const) {
      await tx`
        insert into sap_review (participation_id, status, approved_date, decided_by_person_id)
        values (${thisSeason[i]}, 'approved', ${`${year}-08-2${i}`}, ${admin})`;
      await tx`
        update sap_pass set holder_participation_id = ${thisSeason[i]},
          assigned_by_person_id = ${admin}, assigned_at = now(),
          pdf_key = ${withFiles && withPdf ? samplePassKey(c.id) : null},
          pdf_uploaded_at = ${withFiles && withPdf ? now.toISOString() : null}
        where id = ${passes[serial]}`;
    }

    // A little History, so person pages show what Leads would see.
    const history: Array<[number, string, Record<string, unknown>, Record<string, unknown>]> = [
      [2, "rsvp_updated", { intent: "leaning_yes" }, { intent: "going" }],
      [5, "ticket_request_saved", {}, { ticketsNeeded: 2, vehiclePassNeeded: true }],
      [4, "role_granted", {}, { role: "lead" }],
      [8, "position_assigned", {}, { position: "Kitchen captain", year }],
      [11, "volunteer_signed_up", {}, { role: "Build crew" }],
    ];
    for (const [i, action, before, after] of history) {
      await tx`
        insert into audit_log (actor_type, actor_person_id, action, subject_type, subject_id,
          before, after, created_at)
        values ('person', ${lead}, ${action}, 'person', ${ids[i]}, ${JSON.stringify(before)}::text::jsonb,
          ${JSON.stringify(after)}::text::jsonb, ${plus(now, -20 + i).toISOString()})`;
    }

    // Newcomers who used the join page.
    for (const [i, [n, playa, status]] of [
      ["Sam Ortega", "Doodle", "new"],
      ["Bea Lindgren", null, "contacted"],
      ["Ravi Anand", "Comet", "met"],
    ].entries()) {
      await tx`
        insert into inquiry (name, playa_name, email, status, source, heard_from, note, received_at,
          assigned_to_person_id)
        values (${n}, ${playa}, ${email(n as string)}, ${status}, 'join_form', 'A friend',
          ${"First burn next year, happy to cook!"}, ${plus(now, -3 - i * 4).toISOString()},
          ${status === "new" ? null : lead})`;
    }

    // Guides: the starter library, published as this camp's own.
    for (const [i, g] of starters().entries()) {
      await tx`
        insert into guide (slug, title, summary, body, visibility, sort, published, published_at,
          updated_by_person_id)
        values (${g.slug}, ${g.title.replace("our camp", name)}, ${g.summary}, ${g.body},
          ${g.visibility}, ${i + 1}, true, now(), ${lead})`;
    }

    await tx`
      insert into announcement (title, body, show_until, created_by_person_id) values
        ('Camp meetup in the park', ${"Potluck and planning this Sunday at noon. Bring a chair!"},
          ${day(plus(now, 12))}, ${lead}),
        ('Stewards Sale requests are open', ${"Put in your ticket request by the date below."},
          ${day(plus(now, 25))}, ${admin})`;
    await tx`
      insert into key_date (burn_id, label, date, action) values
        (${seasons[year]}, 'Ticket requests close', ${day(plus(now, 21))}, 'tickets_close'),
        (${seasons[year]}, 'Dues due', ${day(plus(now, 75))}, 'dues_due'),
        (${seasons[year]}, 'Build week starts', ${`${year}-08-20`}, null)`;

    const roles = [
      ["Kitchen lead", "A few hours a week during the burn", 1],
      ["Build crew", "Build week", 5],
      ["Shade and structures", "Before the burn and build week", 2],
      ["Strike crew", "The end of the burn", 4],
      ["MOOP sweep", "The last day", 3],
    ] as const;
    for (const [i, [title, commitment, slots]] of roles.entries()) {
      const [r] = await tx<{ id: string }[]>`
        insert into volunteer_role (title, commitment, slots, sort)
        values (${title}, ${commitment}, ${slots}, ${(i + 1) * 10}) returning id`;
      for (const id of ids.slice(i * 3, i * 3 + Math.min(slots, 2))) {
        await tx`
          insert into volunteer_signup (burn_id, role_id, person_id)
          values (${seasons[year]}, ${r.id}, ${id})`;
      }
    }
    // Elected jobs (issue #106): Leads fill them, and they show in the Yearbook's Who's who.
    for (const [i, [title, holder]] of [
      ["Camp lead", admin],
      ["Treasurer", treasurer],
      ["Kitchen captain", ids[8]],
      ["Decor", ids[11]],
    ].entries()) {
      const [job] = await tx<{ id: string }[]>`
        insert into volunteer_role (title, slots, self_signup, show_in_yearbook, sort)
        values (${title}, 1, false, true, ${(i + 1) * 10 - 1000}) returning id`;
      await tx`
        insert into volunteer_signup (burn_id, role_id, person_id, added_by_person_id)
        values (${seasons[year]}, ${job.id}, ${holder}, ${admin})`;
    }
    return c.id;
  })) as string;
}
