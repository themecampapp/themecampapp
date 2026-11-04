// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { person } from "~/db/schema";
import { sharesContact } from "../contact-sharing.server";
import type { Db } from "../db.server";
import { personHistory } from "../person-history.server";
import { campYears } from "./history.server";
import type { SeasonRow } from "./season-roster.server";

// What the roster's side panel shows about one person (Lead workspace plan, Unit 6): their
// season first, then contact, camp years and the latest of their History. Read-only; editing
// stays on the person page. `season` is their roster row, if they're in this season's camp.
export async function personSummary(
  db: Db,
  // Whether the viewer may see dues (Dues, with the feature on), and everyone's contact
  // details and mailing address (Private details & notes, issue #93).
  { dues, private: seesPrivate }: { dues: boolean; private: boolean },
  personId: string,
  season: SeasonRow | null,
) {
  const [p] = await db.select().from(person).where(eq(person.id, personId));
  if (!p) return null;
  const { entries } = await personHistory(db, personId, 5, { dues });
  // Without Private details & notes: contact details only if they share them in the directory.
  const contact = seesPrivate || sharesContact(p);
  return {
    id: p.id,
    name: p.playaName ?? p.legalName,
    legalName: p.legalName,
    email: contact ? p.email : null,
    phone: contact ? p.phone : null,
    homeLocation: contact ? p.homeLocation : null,
    mailingAddress: seesPrivate ? p.mailingAddress : null,
    active: p.active,
    season,
    campYears: (await campYears(db, [personId])).get(personId) ?? [],
    recent: entries,
  };
}
