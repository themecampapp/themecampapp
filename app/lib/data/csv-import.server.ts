// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { data } from "react-router";
import { burn, importBatch, importRecord, participation, person } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import { parseCsv } from "../csv";
import { MAX_BYTES, MAX_ROWS } from "../csv-import";
import type { Db } from "../db.server";
import {
  cleanText,
  looksLikeMultiplePeople,
  nameKey,
  normalizeEmail,
  parseYears,
  splitQuotedPlaya,
  validPhone,
} from "../import/normalize";
import { type MailingAddress, readMailingAddress } from "../mailing-address";
import { assertCanManagePersonLogin } from "../roles.server";
import { getCampSettings } from "./camp-settings.server";

// R31–R33: a Lead imports people from a CSV file. Uploading parses the file into a pending
// batch and shows a preview; nothing touches the camp's people until the Lead confirms. The
// batch then applies in one transaction as one audited entry, and each row is recorded in
// import_record, so importing the same file again adds nobody twice. (R32's undo isn't built
// for the pilot.)

// Black Rock City's first year in the desert.
const FIRST_BURN = 1990;

const refuse = (reason: string, status = 400) => data({ reason }, { status });

type Field =
  | "name"
  | "playa"
  | "email"
  | "phone"
  | "home"
  | "years"
  | "line1"
  | "line2"
  | "city"
  | "region"
  | "postalCode"
  | "country";

// Column headings we understand, in any case, with or without spaces and punctuation. The
// mailing address ones (issue #78) count only in a file with a street address column, and
// then "City" and "State" belong to the address, not the home location. The people export's
// own headings ("Mailing city"...) are here too, so an export imports back.
const HEADINGS: Record<Field, string[]> = {
  name: ["name", "fullname", "legalname", "realname"],
  playa: ["playaname", "playa", "burnername", "nickname"],
  email: ["email", "emailaddress"],
  phone: ["phone", "phonenumber", "mobile", "cell", "cellphone"],
  home: ["homelocation", "home", "location", "city", "hometown"],
  years: ["pastyears", "pastyearsattended", "yearsattended", "years", "campyears"],
  line1: [
    "mailingaddress",
    "address",
    "streetaddress",
    "street",
    "address1",
    "addressline1",
    "homeaddress",
    "postaladdress",
  ],
  line2: ["mailingaddressline2", "address2", "addressline2", "apt", "apartment", "unit", "suite"],
  city: ["mailingcity", "addresscity", "city", "town", "cityortown"],
  region: [
    "mailingstateorregion",
    "state",
    "province",
    "region",
    "stateprovince",
    "stateorprovince",
    "stateorregion",
    "county",
  ],
  postalCode: ["mailingpostalcode", "zip", "zipcode", "postalcode", "postcode", "zippostalcode"],
  country: ["mailingcountry", "country"],
};
const ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const US_ZIP = /^\d{5}(-\d{4})?$/;

// The template: with the mailing address columns when the camp collects them.
export function templateCsv(mailing: boolean) {
  return [
    `Name,Playa name,Email,Phone,Home location,Past years attended${mailing ? ",Street address,Apartment or unit,City,State,ZIP or postal code,Country" : ""}`,
    `Alex Rivera,Sparky,alex@example.com,555-555-0101,"Oakland, CA","2023, 2025"${mailing ? ",1 Main St,Apt 2,Oakland,CA,94612,United States" : ""}`,
  ].join("\r\n");
}

// One row as read from the file, cleaned. `flags` say what was wrong with what was typed.
export type ImportRow = {
  line: number;
  legalName: string | null;
  playaName: string | null;
  email: string | null;
  phone: string | null;
  homeLocation: string | null;
  // Absent in batches uploaded before mailing addresses existed.
  mailingAddress?: MailingAddress | null;
  years: number[];
  flags: string[];
  key: string;
};

async function sha256Hex(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The file, read and cleaned. Refuses anything that isn't a usable CSV of people. Mailing
// addresses are read only for a camp that collects them.
export async function readPeopleCsv(
  text: string,
  lastPastYear: number,
  { mailing = false }: { mailing?: boolean } = {},
): Promise<ImportRow[]> {
  if (text.includes("\u0000")) throw refuse("import_not_csv");
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch {
    throw refuse("import_not_csv");
  }
  if (table.length < 2) throw refuse("import_empty");
  if (table.length - 1 > MAX_ROWS) throw refuse("import_too_many_rows");
  const header = table[0].map(squash);
  const find = (f: Field, except: number[] = []) =>
    header.findIndex((h, i) => HEADINGS[f].includes(h) && !except.includes(i));
  const col = Object.fromEntries(
    (Object.keys(HEADINGS) as Field[]).map((f) => [f, find(f)]),
  ) as Record<Field, number>;
  if (col.name < 0) throw refuse("import_no_name_column");
  if (!mailing || col.line1 < 0) {
    for (const f of ADDRESS_FIELDS) col[f] = -1;
  } else if (col.home === col.city) {
    // "City" is the address's: the home location is only a column that says so.
    col.home = find("home", [col.city]);
  }

  const rows: ImportRow[] = [];
  for (const [i, cells] of table.slice(1).entries()) {
    const cell = (f: Field) => (col[f] >= 0 ? (cells[col[f]] ?? "") : "");
    const flags: string[] = [];
    let legalName = cleanText(cell("name"));
    let playaName = cleanText(cell("playa"));
    if (legalName && !playaName) {
      const split = splitQuotedPlaya(legalName);
      legalName = split.legal;
      playaName = split.playa;
    }
    if (legalName && looksLikeMultiplePeople(legalName)) {
      flags.push("The name looks like more than one person. Give each their own row.");
    }
    const rawEmail = cleanText(cell("email"));
    const email = normalizeEmail(rawEmail);
    if (rawEmail && !email) flags.push(`"${rawEmail}" isn't an email address, so it's left blank.`);
    const rawPhone = cleanText(cell("phone"));
    const phone = validPhone(rawPhone);
    if (rawPhone && !phone) flags.push(`"${rawPhone}" isn't a phone number, so it's left blank.`);
    const { years, bad } = parseYears(cell("years"), { min: FIRST_BURN, max: lastPastYear });
    if (bad.length) {
      flags.push(
        `Left out of past years: ${bad.join(", ")} (only years from ${FIRST_BURN} to ${lastPastYear}).`,
      );
    }
    const homeLocation = cleanText(cell("home"));
    const mailingAddress = readAddress((f) => cleanText(cell(f)) ?? "", flags);
    const key = await sha256Hex(
      JSON.stringify([
        legalName,
        playaName,
        email,
        phone,
        homeLocation,
        years,
        // Only when there is one, so files imported before addresses existed still match.
        ...(mailingAddress ? [mailingAddress] : []),
      ]),
    );
    rows.push({
      line: i + 2,
      legalName,
      playaName,
      email,
      phone,
      homeLocation,
      mailingAddress,
      years,
      flags,
      key,
    });
  }
  return rows;
}

// A row's mailing address, or null. A US ZIP code with no country is taken as the United
// States; anything else incomplete is left out, with a flag saying why.
function readAddress(
  cell: (f: (typeof ADDRESS_FIELDS)[number]) => string,
  flags: string[],
): MailingAddress | null {
  const parts = Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, cell(f)])) as Record<
    (typeof ADDRESS_FIELDS)[number],
    string
  >;
  if (ADDRESS_FIELDS.every((f) => !parts[f])) return null;
  if (!parts.country && US_ZIP.test(parts.postalCode) && parts.line1 && parts.city) {
    parts.country = "United States";
    flags.push(
      "The mailing address has no country, so it's set to United States (from the ZIP code).",
    );
  }
  const read = readMailingAddress(
    (k) => parts[k.replace(/^mailing_/, "") as keyof typeof parts] ?? "",
  );
  if ("problem" in read) {
    flags.push(
      read.problem.startsWith("A mailing address needs")
        ? "The mailing address needs at least a street, a city and a country, so it's left out."
        : `${read.problem} The mailing address is left out.`,
    );
    return null;
  }
  return read.address;
}

// What will happen to each row, given the camp's people now.
export type Planned =
  | { kind: "create"; sharedEmail: boolean }
  | {
      kind: "duplicate";
      match: { id: string; name: string; email: string | null };
      by: "email" | "name";
    }
  | { kind: "skip"; reason: "no_name" | "already_imported" };

async function plan(db: Db, rows: ImportRow[]): Promise<Planned[]> {
  const people = await db
    .select({
      id: person.id,
      legalName: person.legalName,
      playaName: person.playaName,
      email: person.email,
    })
    .from(person);
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email as string, p]));
  const byName = new Map(people.map((p) => [nameKey(p.legalName), p]));
  const keys = rows.map((r) => `csv:${r.key}`);
  const imported = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const found = await db
      .select({ key: importRecord.sourceKey })
      .from(importRecord)
      .where(inArray(importRecord.sourceKey, keys.slice(i, i + 500)));
    for (const f of found) imported.add(f.key);
  }
  const emailCount = new Map<string, number>();
  for (const r of rows) {
    if (r.legalName && r.email) emailCount.set(r.email, (emailCount.get(r.email) ?? 0) + 1);
  }
  const show = (p: (typeof people)[number]) => ({
    id: p.id,
    name: p.playaName ? `${p.playaName} (${p.legalName})` : p.legalName,
    email: p.email,
  });
  return rows.map((r): Planned => {
    if (!r.legalName) return { kind: "skip", reason: "no_name" };
    if (imported.has(`csv:${r.key}`)) return { kind: "skip", reason: "already_imported" };
    const sameEmail = r.email ? byEmail.get(r.email) : undefined;
    if (sameEmail) return { kind: "duplicate", match: show(sameEmail), by: "email" };
    const sameName = byName.get(nameKey(r.legalName));
    if (sameName && (!r.email || !sameName.email)) {
      return { kind: "duplicate", match: show(sameName), by: "name" };
    }
    return { kind: "create", sharedEmail: !!r.email && (emailCount.get(r.email) ?? 0) > 1 };
  });
}

// Step one: read the upload and keep it as a pending batch.
export async function startImport(db: Db, actor: Viewer, file: File | null) {
  assertAccess(actor, "people");
  if (!file || file.size === 0) throw refuse("import_empty");
  if (file.size > MAX_BYTES) throw refuse("import_too_big");
  if (!/\.(csv|txt)$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) {
    throw refuse("import_not_csv");
  }
  const text = await file.text();
  const [{ year }] = await db.execute<{ year: number }>(sql`select current_year() as year`);
  const { features } = await getCampSettings(db);
  const rows = await readPeopleCsv(text, Number(year) - 1, { mailing: features.mailing });
  const fileHash = await sha256Hex(text);
  return db.transaction(async (tx) => {
    // Unconfirmed batches hold people's details: they don't linger.
    await tx
      .delete(importBatch)
      .where(
        and(
          eq(importBatch.status, "pending"),
          lt(importBatch.createdAt, sql`now() - interval '1 day'`),
        ),
      );
    const [b] = await tx
      .insert(importBatch)
      .values({
        createdByPersonId: actor.personId,
        fileName: file.name.slice(0, 200),
        fileHash,
        rows,
      })
      .returning({ id: importBatch.id });
    return b.id;
  });
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Summary = {
  created: number;
  updated: number;
  skipped: number;
  alreadyImported: number;
  notInvitable: Array<{ id: string; name: string; reason: "no_email" | "shared_email" }>;
};

// A batch for the preview (pending) or its summary (applied), or null.
export async function getImport(db: Db, id: string) {
  if (!ID_RE.test(id)) return null;
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, id));
  if (!b) return null;
  if (b.status === "applied") {
    return { status: "applied" as const, fileName: b.fileName, summary: b.summary as Summary };
  }
  const rows = (b.rows ?? []) as ImportRow[];
  const planned = await plan(db, rows);
  return {
    status: "pending" as const,
    fileName: b.fileName,
    rows: rows.map((r, i) => ({ ...r, planned: planned[i] })),
  };
}

export async function cancelImport(db: Db, actor: Viewer, id: string) {
  assertAccess(actor, "people");
  if (!ID_RE.test(id)) return;
  await db
    .delete(importBatch)
    .where(and(eq(importBatch.id, id), eq(importBatch.status, "pending")));
}

// Step two: apply the batch as previewed, with the Lead's choice for each likely duplicate
// ("update" or the default, "skip"). One transaction, one audit entry.
export async function applyImport(
  db: Db,
  actor: Viewer,
  id: string,
  updates: Set<number>,
): Promise<Summary> {
  assertAccess(actor, "people");
  if (!ID_RE.test(id)) throw refuse("import_not_found", 404);
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(importBatch).where(eq(importBatch.id, id)).for("update");
    if (!b) throw refuse("import_not_found", 404);
    if (b.status !== "pending") throw refuse("import_done", 409);
    const rows = (b.rows ?? []) as ImportRow[];
    // Planned again inside the transaction: the camp's people may have changed since the preview.
    const planned = await plan(tx as unknown as Db, rows);

    // Seasons for past years, made if the camp doesn't have them yet.
    const years = [...new Set(rows.flatMap((r) => r.years))];
    if (years.length) {
      await tx
        .insert(burn)
        .values(years.map((year) => ({ year })))
        .onConflictDoNothing();
    }
    const seasons = new Map(
      years.length
        ? (
            await tx
              .select({ id: burn.id, year: burn.year })
              .from(burn)
              .where(inArray(burn.year, years))
          ).map((s) => [s.year, s.id])
        : [],
    );
    const attended = async (personId: string, ys: number[]) => {
      for (const y of ys) {
        await tx
          .insert(participation)
          .values({ personId, burnId: seasons.get(y) as string, attended: true })
          .onConflictDoUpdate({
            target: [participation.personId, participation.burnId],
            set: { attended: true },
          });
      }
    };
    const record = async (r: ImportRow, targetId: string) => {
      await tx
        .insert(importRecord)
        .values({
          sourceKey: `csv:${r.key}`,
          sourceSheet: `csv:${b.fileName}`.slice(0, 200),
          sourceRow: r.line,
          rowHash: r.key.slice(0, 16),
          targetTable: "person",
          targetId,
          batchId: b.id,
        })
        .onConflictDoNothing();
    };

    const summary: Summary = {
      created: 0,
      updated: 0,
      skipped: 0,
      alreadyImported: 0,
      notInvitable: [],
    };
    const touched: string[] = [];
    for (const [i, r] of rows.entries()) {
      const p = planned[i];
      if (p.kind === "skip") {
        if (p.reason === "already_imported") summary.alreadyImported++;
        else summary.skipped++;
        continue;
      }
      if (p.kind === "duplicate") {
        if (!updates.has(r.line)) {
          summary.skipped++;
          continue;
        }
        const [before] = await tx
          .select()
          .from(person)
          .where(eq(person.id, p.match.id))
          .for("update");
        if (!before.email && r.email) {
          await assertCanManagePersonLogin(tx, actor, before.id);
          if (before.authUserId) throw refuse("linked_email_locked", 409);
        }
        await tx
          .update(person)
          .set({
            legalName: r.legalName ?? before.legalName,
            playaName: r.playaName ?? before.playaName,
            phone: r.phone ?? before.phone,
            homeLocation: r.homeLocation ?? before.homeLocation,
            mailingAddress: r.mailingAddress ?? before.mailingAddress,
            // Never replaces an email: that's how someone signs in.
            email: before.email ?? r.email,
            updatedAt: new Date(),
          })
          .where(eq(person.id, before.id));
        await attended(before.id, r.years);
        await record(r, before.id);
        touched.push(before.id);
        summary.updated++;
        continue;
      }
      const [created] = await tx
        .insert(person)
        .values({
          legalName: r.legalName as string,
          playaName: r.playaName,
          email: r.email,
          phone: r.phone,
          homeLocation: r.homeLocation,
          mailingAddress: r.mailingAddress ?? null,
        })
        .returning({ id: person.id });
      await attended(created.id, r.years);
      await record(r, created.id);
      touched.push(created.id);
      summary.created++;
    }

    // R33: who can't be invited until a Lead fixes them.
    if (touched.length) {
      const blocked = await tx.execute<{ id: string; name: string; shared: boolean }>(sql`
        select p.id, coalesce(p.playa_name || ' (' || p.legal_name || ')', p.legal_name) as name,
          exists (select 1 from person o where o.email = p.email and o.id <> p.id and o.active)
            as shared
        from person p
        where p.id in (${sql.join(
          touched.map((t) => sql`${t}::uuid`),
          sql`, `,
        )})
          and (p.email is null or exists (
            select 1 from person o where o.email = p.email and o.id <> p.id and o.active))
        order by 2`);
      summary.notInvitable = blocked.map((x) => ({
        id: x.id,
        name: x.name,
        reason: x.shared ? "shared_email" : "no_email",
      }));
    }

    await tx
      .update(importBatch)
      .set({ status: "applied", rows: null, summary, appliedAt: new Date() })
      .where(eq(importBatch.id, b.id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "people_imported",
      subjectType: "import_batch",
      subjectId: b.id,
      after: {
        file: b.fileName,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped + summary.alreadyImported,
        notInvitable: summary.notInvitable.length,
      },
    });
    return summary;
  });
}
