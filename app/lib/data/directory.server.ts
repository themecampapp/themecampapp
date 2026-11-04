// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { person } from "~/db/schema";
import { can, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import { SHARES_CONTACT } from "../contact-sharing.server";
import type { Db } from "../db.server";
import { cardLabel } from "../photos.server";

// The camp directory (R6): this season's Going / Leaning-yes campers. Everyone sees the
// Yearbook name (playa name, or first name) and home location. Full name, email and phone are
// shown only when the camper has seen the directory choice and chosen to share, or to Leads,
// or to themselves. It never selects logistics, notes, dues or tickets.

export type DirectoryEntry = {
  personId: string; // server-side only: used to look up jobs, never sent to the page
  label: string;
  homeLocation: string | null; // shown to all members (a camp decision, not a per-person choice)
  photoKey: string | null;
  isYou: boolean;
  contact: { fullName: string; email: string | null; phone: string | null } | null;
};

export async function directory(db: Db, viewer: Viewer): Promise<DirectoryEntry[]> {
  const rows = await db.execute<{
    id: string;
    legal_name: string;
    playa_name: string | null;
    email: string | null;
    phone: string | null;
    home_location: string | null;
    photo_key: string | null;
    show_first: boolean;
    shares: boolean;
  }>(sql`
    select p.id, p.legal_name, p.playa_name, p.email, p.phone, p.home_location, p.photo_key,
      p.yearbook_show_first_name as show_first,
      ${SHARES_CONTACT} as shares
    from person p
    join participation pa on pa.person_id = p.id
    join burn b on b.id = pa.burn_id and b.year = current_year()
    where p.active and pa.intent in ('going', 'leaning_yes')
    order by lower(coalesce(p.playa_name, p.legal_name))
  `);
  return rows.map((r) => {
    const isYou = r.id === viewer.personId;
    const visible = r.shares || can(viewer, "private") || isYou;
    return {
      personId: r.id,
      label: cardLabel({
        playaName: r.playa_name,
        legalName: r.legal_name,
        showFirstName: r.show_first,
      }).label,
      homeLocation: r.home_location,
      photoKey: r.photo_key,
      isYou,
      contact: visible ? { fullName: r.legal_name, email: r.email, phone: r.phone } : null,
    };
  });
}

export async function directoryChoice(db: Db, personId: string) {
  const [p] = await db
    .select({ seenAt: person.directoryChoiceSeenAt, hidden: person.directoryHidden })
    .from(person)
    .where(eq(person.id, personId));
  return { chosen: !!p?.seenAt, sharing: !!p?.seenAt && !p.hidden };
}

// Records the member's choice. The first choice is what makes contacts visible at all.
export async function setDirectoryChoice(db: Db, personId: string, share: boolean) {
  await db.transaction(async (tx) => {
    await tx
      .update(person)
      .set({
        directoryHidden: !share,
        directoryChoiceSeenAt: sql`coalesce(${person.directoryChoiceSeenAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(person.id, personId));
    await audit(tx, {
      actorPersonId: personId,
      action: "directory_choice",
      subjectType: "person",
      subjectId: personId,
      after: { share },
    });
  });
}
