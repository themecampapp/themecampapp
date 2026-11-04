// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { campSettings } from "~/db/schema";
import type { Viewer } from "../access.server";
import { audit } from "../audit.server";
import { normalizeHex, readableAccent } from "../contrast";
import type { Db } from "../db.server";
import { methodKey } from "../dues";
import { normalizeEmail } from "../email";
import { FEATURES, type FeatureKey, type Features } from "../features";
import { looksLikeLink } from "../links";

// The camp's own settings (R19, R20, R22), edited by its Admins. Row-level security keeps each
// camp to its own row.

export type CampSettings = {
  campId: string;
  name: string;
  accent: string | null;
  logoKey: string | null;
  contactEmail: string | null;
  inquiryNotify: string[];
  maxTickets: number;
  volunteerMaxRoles: number | null;
  paymentMethods: string[];
  features: Features;
  currentYear: number;
  // U16. Only camps created in the console must accept the pilot agreement and get the setup
  // checklist.
  setup: {
    createdInConsole: boolean;
    agreementAccepted: boolean;
    featuresReviewed: boolean;
    rolesReviewed: boolean;
    checklistDismissed: boolean;
    communityJoined: boolean;
  };
};

const COLUMN: Record<FeatureKey, keyof typeof campSettings.$inferSelect> = {
  dues: "featureDues",
  join: "featureJoin",
  yearbook: "featureYearbook",
  saps: "featureSaps",
  volunteer: "featureVolunteer",
  mailing: "featureMailing",
};

export async function getCampSettings(db: Pick<Db, "execute">): Promise<CampSettings> {
  const [row] = await db.execute<Record<string, unknown>>(sql`
    select s.*, c.name as camp_name, c.created_in_console
    from camp_settings s join camp c on c.id = s.camp_id`);
  if (!row) throw new Error("this camp has no settings row");
  const features = Object.fromEntries(
    (Object.entries(COLUMN) as Array<[FeatureKey, string]>).map(([key, col]) => [
      key,
      row[col.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] === true,
    ]),
  ) as Features;
  return {
    campId: row.camp_id as string,
    name: ((row.display_name as string | null) ?? (row.camp_name as string)).trim(),
    accent: (row.accent as string | null) ?? null,
    logoKey: (row.logo_key as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    inquiryNotify: (row.inquiry_notify as string[]) ?? [],
    maxTickets: Number(row.max_tickets),
    volunteerMaxRoles: row.volunteer_max_roles == null ? null : Number(row.volunteer_max_roles),
    paymentMethods: (row.payment_methods as string[]) ?? [],
    features,
    currentYear: Number(row.current_year),
    setup: {
      createdInConsole: row.created_in_console === true,
      agreementAccepted: row.agreement_accepted_at != null,
      featuresReviewed: row.features_reviewed_at != null,
      rolesReviewed: row.roles_reviewed_at != null,
      checklistDismissed: row.checklist_dismissed_at != null,
      communityJoined: row.community_joined_at != null,
    },
  };
}

const refuse = (reason: string) => data({ reason }, { status: 400 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SettingsInput = {
  name: string;
  accent: string;
  contactEmail: string;
  inquiryNotify: string;
  maxTickets: string;
  paymentMethods: string;
};

// A comma- or newline-separated list, trimmed, without blanks or repeats.
const list = (value: string, max: number) =>
  [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ].slice(0, max);

export async function saveCampSettings(db: Db, actor: Viewer, input: SettingsInput) {
  if (!actor.isAdmin) throw data({ reason: "admin_only" }, { status: 403 });
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw refuse("camp_name_needed");
  if (name.length > 60) throw refuse("camp_name_too_long");
  // The name goes into every email, sign-in links included (see links.ts).
  if (looksLikeLink(name)) throw refuse("camp_name_link");

  let accent: string | null = null;
  if (input.accent.trim()) {
    accent = normalizeHex(input.accent);
    if (!accent) throw refuse("accent_not_a_colour");
    if (!readableAccent(accent)) throw refuse("accent_too_dark");
  }

  const contactEmail = input.contactEmail.trim() ? normalizeEmail(input.contactEmail) : null;
  if (contactEmail && !EMAIL_RE.test(contactEmail)) throw refuse("invalid_email");

  const inquiryNotify = list(input.inquiryNotify, 10).map(normalizeEmail);
  if (inquiryNotify.some((e) => !EMAIL_RE.test(e))) throw refuse("notify_email_invalid");

  const maxTickets = Number(input.maxTickets);
  if (!Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 10) {
    throw refuse("max_tickets_range");
  }

  const paymentMethods = [
    ...new Set(list(input.paymentMethods, 12).map((m) => methodKey(m.slice(0, 30)))),
  ];
  if (paymentMethods.length === 0) throw refuse("payment_methods_needed");

  const next = {
    displayName: name,
    accent,
    contactEmail,
    inquiryNotify,
    maxTickets,
    paymentMethods,
  };
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(campSettings).for("update");
    await tx
      .update(campSettings)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(campSettings.campId, before.campId));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "camp_settings_saved",
      subjectType: "camp",
      subjectId: before.campId,
      before: {
        displayName: before.displayName,
        accent: before.accent,
        contactEmail: before.contactEmail,
        inquiryNotify: before.inquiryNotify,
        maxTickets: before.maxTickets,
        paymentMethods: before.paymentMethods,
      },
      after: next,
    });
  });
}

export async function saveFeatures(db: Db, actor: Viewer, on: Set<FeatureKey>) {
  if (!actor.isAdmin) throw data({ reason: "admin_only" }, { status: 403 });
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(campSettings).for("update");
    const next = Object.fromEntries(FEATURES.map((f) => [COLUMN[f.key], on.has(f.key)]));
    await tx
      .update(campSettings)
      // Saving the page counts as reviewing the features (the setup checklist, R24).
      .set({ ...next, featuresReviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(campSettings.campId, before.campId));
    const was = FEATURES.filter((f) => before[COLUMN[f.key]] === true).map((f) => f.key);
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "features_saved",
      subjectType: "camp",
      subjectId: before.campId,
      before: { on: was },
      after: { on: [...on] },
    });
  });
}
