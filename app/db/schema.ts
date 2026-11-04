// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { MailingAddress } from "../lib/mailing-address";
import { user } from "./auth-schema";

const id = () => uuid("id").defaultRandom().primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

// ---------------------------------------------------------------------------------------------
// Tenancy. Every camp-owned row carries camp_id. It defaults to current_camp_id(), the camp set
// on the transaction (set_config('app.camp_id', ..., true)), so inserts never pass it by hand;
// with no camp set the default is NULL and the insert fails. Row-level security (FORCE, policy
// camp_isolation, see drizzle/0002_*) limits every read and write to that camp, and references
// between camp tables are composite (camp_id, x_id) -> (camp_id, id), so a row can never point
// at another camp's row. Tables without camp_id (camp, Better Auth's) are platform-wide.
// ---------------------------------------------------------------------------------------------

export const CAMP_KINDS = ["camp", "demo"] as const;
export const CAMP_STATUSES = ["active", "suspended", "pending_deletion"] as const;

// Platform-owned identity and status. Only platform code writes it (the camp Worker's role can
// only read it, to route hosts); anything a camp edits lives in camp_settings.
export const camp = pgTable(
  "camp",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind", { enum: CAMP_KINDS }).default("camp").notNull(),
    status: text("status", { enum: CAMP_STATUSES }).default("active").notNull(),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    dailySendCap: integer("daily_send_cap").default(300).notNull(),
    sendingPaused: boolean("sending_paused").default(false).notNull(),
    // Created by the operator in the console (U16): its first Admin must accept the pilot
    // agreement, and its Admins and Leads get the setup checklist. Camps set up by hand before
    // the console existed (the first pilot camp, staging's sandbox) have neither.
    createdInConsole: boolean("created_in_console").default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("camp_slug_ck", sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'`),
    check("camp_kind_ck", sql`${t.kind} in ('camp','demo')`),
    check("camp_status_ck", sql`${t.status} in ('active','suspended','pending_deletion')`),
  ],
);

const campId = () =>
  uuid("camp_id")
    .notNull()
    .default(sql`current_camp_id()`)
    .references(() => camp.id, { onDelete: "cascade" });

// A composite reference from a camp table to another camp table's (camp_id, id).
// biome-ignore lint/suspicious/noExplicitAny: drizzle column types are generic per table
type Col = any;
const campFk = (name: string, from: Col, fromCampId: Col, to: { campId: Col; id: Col }) =>
  foreignKey({ name, columns: [fromCampId, from], foreignColumns: [to.campId, to.id] });

// A human in the camp's world. Email is normalized (trimmed, lowercased) and deliberately
// not unique: couples sometimes share one. auth_user_id links a Better Auth login (U3).
export const person = pgTable(
  "person",
  {
    id: id(),
    campId: campId(),
    legalName: text("legal_name").notNull(),
    playaName: text("playa_name"),
    email: text("email"),
    phone: text("phone"),
    homeLocation: text("home_location"),
    // Issue #78: where the camp can post things to them (optional; app/lib/mailing-address.ts).
    // Only the person, Leads and Admins see it: never the directory or the Yearbook.
    mailingAddress: jsonb("mailing_address").$type<MailingAddress>(),
    authUserId: text("auth_user_id").references(() => user.id, { onDelete: "set null" }),
    active: boolean("active").default(true).notNull(),
    directoryHidden: boolean("directory_hidden").default(false).notNull(),
    directoryChoiceSeenAt: timestamp("directory_choice_seen_at", { withTimezone: true }),
    photoKey: text("photo_key"),
    photoUpdatedAt: timestamp("photo_updated_at", { withTimezone: true }),
    yearbookShowFirstName: boolean("yearbook_show_first_name").default(false).notNull(),
    note2026: text("note_2026"), // Lead-only
    // When they saw the privacy notice on their first sign-in here (R51).
    privacyNoticeSeenAt: timestamp("privacy_notice_seen_at", { withTimezone: true }),
    // R74: the last day this person used the app, for the console's count of active members
    // (never listed). Set at most once a day, with the day's usage count (app/lib/usage.server.ts).
    lastSeenOn: date("last_seen_on"),
    // Issue #65: the Lead and Admin orientation. How far it's done ("lead": the Lead steps,
    // "admin": all of them; finished or stopped), and the step it was paused on.
    orientationDone: text("orientation_done", { enum: ["lead", "admin"] }),
    orientationStep: text("orientation_step"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("person_camp_id_ux").on(t.campId, t.id),
    // One login, one person per camp: the same login has a separate person in each camp.
    uniqueIndex("person_auth_user_ux").on(t.campId, t.authUserId),
    index("person_email_ix").on(t.campId, t.email),
    check(
      "person_orientation_ck",
      sql`${t.orientationDone} is null or ${t.orientationDone} in ('lead','admin')`,
    ),
    check("person_orientation_step_ck", sql`char_length(${t.orientationStep}) <= 40`),
    check(
      "person_mailing_ck",
      sql`${t.mailingAddress} is null or jsonb_typeof(${t.mailingAddress}) = 'object'`,
    ),
  ],
);

export const burn = pgTable(
  "burn",
  {
    id: id(),
    campId: campId(),
    year: integer("year").notNull(),
    duesAmountCents: integer("dues_amount_cents"),
    paymentInstructions: text("payment_instructions"),
    ticketRequestsLocked: boolean("ticket_requests_locked").default(false).notNull(),
    // The days campers can pick for a Setup Access Pass this season (ISO dates). Each season
    // starts with none until an Admin sets them.
    sapDays: jsonb("sap_days").$type<string[]>().default([]).notNull(),
  },
  (t) => [
    unique("burn_camp_id_ux").on(t.campId, t.id),
    unique("burn_camp_year_ux").on(t.campId, t.year),
  ],
);

// Everything the camp itself edits. One row per camp; U6 adds the settings pages' columns.
export const campSettings = pgTable(
  "camp_settings",
  {
    campId: uuid("camp_id")
      .primaryKey()
      .default(sql`current_camp_id()`)
      .references(() => camp.id, { onDelete: "cascade" }),
    // The camp's working season, read everywhere through the SQL function current_year(). It
    // must be one of the camp's seasons.
    currentYear: integer("current_year").notNull(),
    // What the camp's Admins set (R19, R22). The name shown everywhere; the platform's own
    // camp.name is used until the camp sets one.
    displayName: text("display_name"),
    // A button and highlight colour (#rrggbb), dark text must stay readable on it (app/lib/contrast.ts).
    accent: text("accent"),
    // The camp's logo in the private bucket (camps/<camp id>/logo/<uuid>.webp), served publicly
    // at /logo/<name> since it shows on the sign-in page too.
    logoKey: text("logo_key"),
    // Reply-to on the camp's emails (U7).
    contactEmail: text("contact_email"),
    // Who's told about new inquiries.
    inquiryNotify: jsonb("inquiry_notify").$type<string[]>().default([]).notNull(),
    maxTickets: integer("max_tickets").default(2).notNull(),
    // Issue #29: the most jobs a member may take themselves (null: no limit). Leads
    // can still add someone beyond it.
    volunteerMaxRoles: integer("volunteer_max_roles"),
    paymentMethods: jsonb("payment_methods")
      .$type<string[]>()
      .default(["venmo", "zelle", "cash", "other"])
      .notNull(),
    // Feature switches (R20). Off hides a feature's pages, emails and dates; its data stays.
    featureDues: boolean("feature_dues").default(true).notNull(),
    featureJoin: boolean("feature_join").default(true).notNull(),
    featureYearbook: boolean("feature_yearbook").default(true).notNull(),
    featureSaps: boolean("feature_saps").default(false).notNull(),
    featureVolunteer: boolean("feature_volunteer").default(false).notNull(),
    // Issue #78: campers' mailing addresses (profile, Leads' pages, export). Off by default.
    featureMailing: boolean("feature_mailing").default(false).notNull(),
    // R68: the pilot agreement, accepted by one of the camp's Admins (which version, who, when).
    // No foreign key on who: people are anonymized, never deleted, and the audit log has it too.
    agreementVersion: text("agreement_version"),
    agreementAcceptedAt: timestamp("agreement_accepted_at", { withTimezone: true }),
    agreementAcceptedBy: uuid("agreement_accepted_by"),
    // R24: the setup checklist. The features page counts as reviewed once it's been saved.
    featuresReviewedAt: timestamp("features_reviewed_at", { withTimezone: true }),
    checklistDismissedAt: timestamp("checklist_dismissed_at", { withTimezone: true }),
    // Issue #82: someone in the camp opened the Theme Camp App Discord from the checklist.
    communityJoinedAt: timestamp("community_joined_at", { withTimezone: true }),
    // Issue #93: an Admin has looked at Admin → Roles (saved a role, or said they look right).
    rolesReviewedAt: timestamp("roles_reviewed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("camp_settings_accent_ck", sql`${t.accent} is null or ${t.accent} ~ '^#[0-9a-f]{6}$'`),
    check(
      "camp_settings_volunteer_max_ck",
      sql`${t.volunteerMaxRoles} is null or ${t.volunteerMaxRoles} between 1 and 20`,
    ),
    check("camp_settings_max_tickets_ck", sql`${t.maxTickets} between 1 and 10`),
    foreignKey({
      name: "camp_settings_current_year_fk",
      columns: [t.campId, t.currentYear],
      foreignColumns: [burn.campId, burn.year],
    }),
  ],
);

export const INTENTS = ["going", "leaning_yes", "leaning_no", "not_going"] as const;
export const PRE_BURN_INTENTS = [
  "yes_going",
  "leaning_yes",
  "leaning_no",
  "not_sure",
  "not_going",
] as const;

export const participation = pgTable(
  "participation",
  {
    id: id(),
    campId: campId(),
    personId: uuid("person_id").notNull(),
    burnId: uuid("burn_id").notNull(),
    intent: text("intent", { enum: INTENTS }),
    preBurnIntent: text("pre_burn_intent", { enum: PRE_BURN_INTENTS }), // from a 2026 import only
    attended: boolean("attended"), // whether they came: recorded at rollover, or when imported
    arrivalDate: date("arrival_date"),
    departureDate: date("departure_date"),
    sapRequested: boolean("sap_requested"), // asking for a Setup Access Pass (early arrival)
    sapDate: date("sap_date"), // the day they'd like to arrive early
    dwellingDescription: text("dwelling_description"),
    dwellingSize: text("dwelling_size"),
    generator: boolean("generator"),
    updatedByPersonId: uuid("updated_by_person_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("participation_camp_id_ux").on(t.campId, t.id),
    campFk("participation_person_fk", t.personId, t.campId, person),
    campFk("participation_burn_fk", t.burnId, t.campId, burn),
    campFk("participation_updated_by_fk", t.updatedByPersonId, t.campId, person),
    uniqueIndex("participation_person_burn_ux").on(t.personId, t.burnId),
    check(
      "participation_intent_ck",
      sql`${t.intent} is null or ${t.intent} in ('going','leaning_yes','leaning_no','not_going')`,
    ),
    check(
      "participation_pre_burn_intent_ck",
      sql`${t.preBurnIntent} is null or ${t.preBurnIntent} in ('yes_going','leaning_yes','leaning_no','not_sure','not_going')`,
    ),
  ],
);

// The sign-in allowlist. One pending invite per person at a time.
export const invite = pgTable(
  "invite",
  {
    id: id(),
    campId: campId(),
    personId: uuid("person_id").notNull(),
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "linked", "revoked"] })
      .default("pending")
      .notNull(),
    sentByPersonId: uuid("sent_by_person_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("invite_person_fk", t.personId, t.campId, person),
    campFk("invite_sent_by_fk", t.sentByPersonId, t.campId, person),
    uniqueIndex("invite_one_pending_per_person_ux")
      .on(t.personId)
      .where(sql`${t.status} = 'pending'`),
    index("invite_email_ix").on(t.campId, t.email),
    check("invite_status_ck", sql`${t.status} in ('pending','linked','revoked')`),
  ],
);

// Issue #93: a camp's own roles. A row with `builtin` set is the camp's customized Lead or
// Treasurer (no row: the app's defaults, app/lib/permissions.ts); a row without is a custom
// role with its own name. `grants` is a level per area. Custom roles are archived, never
// deleted, so past assignments and the audit log keep pointing at them.
export const campRole = pgTable(
  "camp_role",
  {
    id: id(),
    campId: campId(),
    builtin: text("builtin", { enum: ["lead", "treasurer"] }),
    name: text("name"),
    description: text("description"),
    grants: jsonb("grants").$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("camp_role_camp_id_ux").on(t.campId, t.id),
    uniqueIndex("camp_role_builtin_ux")
      .on(t.campId, t.builtin)
      .where(sql`${t.builtin} is not null`),
    uniqueIndex("camp_role_name_ux")
      .on(t.campId, sql`lower(${t.name})`)
      .where(sql`${t.name} is not null and ${t.archivedAt} is null`),
    check("camp_role_kind_ck", sql`(${t.builtin} is null) = (${t.name} is not null)`),
    check("camp_role_name_ck", sql`${t.name} is null or char_length(${t.name}) between 1 and 40`),
    check(
      "camp_role_description_ck",
      sql`${t.description} is null or char_length(${t.description}) <= 200`,
    ),
    check("camp_role_builtin_archived_ck", sql`${t.builtin} is null or ${t.archivedAt} is null`),
  ],
);

// Member is implied by an active, linked person; only the elevated roles are stored. A custom
// role (issue #93) is role "custom" with its camp_role.
export const memberRole = pgTable(
  "member_role",
  {
    id: id(),
    campId: campId(),
    personId: uuid("person_id").notNull(),
    role: text("role", { enum: ["lead", "treasurer", "admin", "custom"] }).notNull(),
    customRoleId: uuid("custom_role_id"),
    grantedByPersonId: uuid("granted_by_person_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedByPersonId: uuid("revoked_by_person_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    campFk("member_role_person_fk", t.personId, t.campId, person),
    campFk("member_role_granted_by_fk", t.grantedByPersonId, t.campId, person),
    campFk("member_role_revoked_by_fk", t.revokedByPersonId, t.campId, person),
    campFk("member_role_custom_role_fk", t.customRoleId, t.campId, campRole),
    // Each built-in role at most once per person, and each custom role at most once.
    uniqueIndex("member_role_active_ux")
      .on(t.personId, t.role)
      .where(sql`${t.revokedAt} is null and ${t.role} <> 'custom'`),
    uniqueIndex("member_role_custom_active_ux")
      .on(t.personId, t.customRoleId)
      .where(sql`${t.revokedAt} is null and ${t.role} = 'custom'`),
    check("member_role_role_ck", sql`${t.role} in ('lead','treasurer','admin','custom')`),
    check("member_role_custom_ck", sql`(${t.role} = 'custom') = (${t.customRoleId} is not null)`),
  ],
);

export const ticketRequest = pgTable(
  "ticket_request",
  {
    id: id(),
    campId: campId(),
    participationId: uuid("participation_id").notNull().unique(),
    ticketsNeeded: integer("tickets_needed").notNull(),
    hasTicketElsewhere: boolean("has_ticket_elsewhere").default(false).notNull(),
    vehiclePassNeeded: boolean("vehicle_pass_needed").default(false).notNull(),
    note: text("note"),
    active: boolean("active").default(true).notNull(),
    updatedByPersonId: uuid("updated_by_person_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    campFk("ticket_request_participation_fk", t.participationId, t.campId, participation),
    campFk("ticket_request_updated_by_fk", t.updatedByPersonId, t.campId, person),
    // The camp's own maximum (camp_settings.max_tickets) is checked by the app.
    check("ticket_request_count_ck", sql`${t.ticketsNeeded} between 0 and 10`),
  ],
);

// Setup Access Passes Burning Man allocates to the camp, each for one arrival day. Admins add
// them (serial number, and the PDF campers print); Leads assign them to approved campers.
export const sapPass = pgTable(
  "sap_pass",
  {
    id: id(),
    campId: campId(),
    burnId: uuid("burn_id").notNull(),
    validDate: date("valid_date").notNull(),
    serial: text("serial").notNull(),
    pdfKey: text("pdf_key"),
    pdfUploadedAt: timestamp("pdf_uploaded_at", { withTimezone: true }),
    holderParticipationId: uuid("holder_participation_id"),
    assignedByPersonId: uuid("assigned_by_person_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("sap_pass_burn_fk", t.burnId, t.campId, burn),
    campFk("sap_pass_holder_fk", t.holderParticipationId, t.campId, participation),
    campFk("sap_pass_assigned_by_fk", t.assignedByPersonId, t.campId, person),
    uniqueIndex("sap_pass_burn_serial_ux").on(t.burnId, t.serial),
    // A camper holds at most one pass, and a pass has at most one holder.
    uniqueIndex("sap_pass_holder_ux")
      .on(t.holderParticipationId)
      .where(sql`${t.holderParticipationId} is not null`),
  ],
);

export const SAP_DECISIONS = ["approved", "denied"] as const;

// A Lead's decision on a camper's SAP request. No row means it's waiting for a decision.
// `flagged` marks requests whose RSVP changed after the decision.
export const sapReview = pgTable(
  "sap_review",
  {
    id: id(),
    campId: campId(),
    participationId: uuid("participation_id").notNull().unique(),
    status: text("status", { enum: SAP_DECISIONS }).notNull(),
    approvedDate: date("approved_date"),
    flagged: boolean("flagged").default(false).notNull(),
    decidedByPersonId: uuid("decided_by_person_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    campFk("sap_review_participation_fk", t.participationId, t.campId, participation),
    campFk("sap_review_decided_by_fk", t.decidedByPersonId, t.campId, person),
    check("sap_review_status_ck", sql`${t.status} in ('approved','denied')`),
  ],
);

// A camp's guides (R28), written in Markdown by its Leads and Admins. Only published guides
// are shown outside the editor, to whoever the visibility allows; public guides are the only
// camp content anyone can read signed out (R29). The slug is set from the title when the
// guide is created and never changes, so links to it keep working.
export const GUIDE_VISIBILITIES = ["public", "members", "leads"] as const;
export const guide = pgTable(
  "guide",
  {
    id: id(),
    campId: campId(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").default("").notNull(),
    body: text("body").default("").notNull(),
    visibility: text("visibility", { enum: GUIDE_VISIBILITIES }).default("members").notNull(),
    sort: integer("sort").default(0).notNull(),
    published: boolean("published").default(false).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedByPersonId: uuid("updated_by_person_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("guide_camp_id_ux").on(t.campId, t.id),
    unique("guide_camp_slug_ux").on(t.campId, t.slug),
    check("guide_slug_ck", sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$'`),
    check("guide_visibility_ck", sql`${t.visibility} in ('public','members','leads')`),
    campFk("guide_updated_by_fk", t.updatedByPersonId, t.campId, person),
  ],
);

// Home-page announcements (R61). Shown to active members while show_until is today or later;
// nothing needs to take them down. Any Lead can edit or remove any of them.
export const announcement = pgTable(
  "announcement",
  {
    id: id(),
    campId: campId(),
    title: text("title").notNull(),
    body: text("body").default("").notNull(),
    showUntil: date("show_until").notNull(),
    // R62: emailed once to the season's members (U19): when, by whom, and how many it reached.
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    emailedByPersonId: uuid("emailed_by_person_id"),
    emailedCount: integer("emailed_count"),
    createdByPersonId: uuid("created_by_person_id"),
    updatedByPersonId: uuid("updated_by_person_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("announcement_camp_id_ux").on(t.campId, t.id),
    index("announcement_camp_show_until_ix").on(t.campId, t.showUntil),
    campFk("announcement_created_by_fk", t.createdByPersonId, t.campId, person),
    campFk("announcement_updated_by_fk", t.updatedByPersonId, t.campId, person),
  ],
);

// A season's key dates (R63): a label and a date, optionally tied to something members do.
// A date tied to a switched-off feature is hidden.
export const KEY_DATE_ACTIONS = ["tickets_close", "dues_due", "rsvp_by"] as const;
export const keyDate = pgTable(
  "key_date",
  {
    id: id(),
    campId: campId(),
    burnId: uuid("burn_id").notNull(),
    label: text("label").notNull(),
    date: date("date").notNull(),
    action: text("action", { enum: KEY_DATE_ACTIONS }),
    // R63: email a reminder a few days before, to those who haven't done the action (U19).
    remind: boolean("remind").default(false).notNull(),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("key_date_camp_id_ux").on(t.campId, t.id),
    index("key_date_camp_burn_date_ix").on(t.campId, t.burnId, t.date),
    check(
      "key_date_action_ck",
      sql`${t.action} is null or ${t.action} in ('tickets_close','dues_due','rsvp_by')`,
    ),
    campFk("key_date_burn_fk", t.burnId, t.campId, burn),
  ],
);

// The camp's jobs (issue #6; called "jobs" on screen since issue #106, which also folded the
// elected positions in). The list carries over from year to year and Leads edit it; who's in
// each job is per season (volunteer_signup). `slots` is how many people the job needs.
// `self_signup`: members can sign up themselves, or only Leads fill it. `show_in_yearbook`: it
// and its people appear in the Yearbook's Who's who.
export const volunteerRole = pgTable(
  "volunteer_role",
  {
    id: id(),
    campId: campId(),
    title: text("title").notNull(),
    commitment: text("commitment"),
    description: text("description"),
    slots: integer("slots").default(1).notNull(),
    selfSignup: boolean("self_signup").default(true).notNull(),
    showInYearbook: boolean("show_in_yearbook").default(false).notNull(),
    sort: integer("sort").default(0).notNull(),
    retired: boolean("retired").default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("volunteer_role_camp_id_ux").on(t.campId, t.id),
    check("volunteer_role_slots_ck", sql`${t.slots} between 1 and 50`),
  ],
);

export const volunteerSignup = pgTable(
  "volunteer_signup",
  {
    id: id(),
    campId: campId(),
    burnId: uuid("burn_id").notNull(),
    roleId: uuid("role_id").notNull(),
    personId: uuid("person_id").notNull(),
    addedByPersonId: uuid("added_by_person_id"),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("volunteer_signup_burn_fk", t.burnId, t.campId, burn),
    campFk("volunteer_signup_role_fk", t.roleId, t.campId, volunteerRole),
    campFk("volunteer_signup_person_fk", t.personId, t.campId, person),
    campFk("volunteer_signup_added_by_fk", t.addedByPersonId, t.campId, person),
    uniqueIndex("volunteer_signup_ux").on(t.burnId, t.roleId, t.personId),
  ],
);

// Named dues amounts beyond the season's standard one (issue #63), e.g. need-based or for
// certain Leads. The Treasurer sets them up each season and puts campers on them; a camper on
// none pays the standard amount (burn.dues_amount_cents). No rules about who qualifies.
export const duesTier = pgTable(
  "dues_tier",
  {
    id: id(),
    campId: campId(),
    burnId: uuid("burn_id").notNull(),
    name: text("name").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("dues_tier_camp_id_ux").on(t.campId, t.id),
    uniqueIndex("dues_tier_name_ux").on(t.burnId, sql`lower(${t.name})`),
    // Season settings: they go with the season.
    campFk("dues_tier_burn_fk", t.burnId, t.campId, burn).onDelete("cascade"),
    check("dues_tier_name_ck", sql`char_length(${t.name}) between 1 and 60`),
    check("dues_tier_amount_ck", sql`${t.amountCents} between 0 and 10000000`),
  ],
);

export const dues = pgTable(
  "dues",
  {
    id: id(),
    campId: campId(),
    participationId: uuid("participation_id").notNull().unique(),
    // The camper's tier this season; null is the standard amount.
    tierId: uuid("tier_id"),
    status: text("status", { enum: ["unpaid", "paid", "waived"] })
      .default("unpaid")
      .notNull(),
    amountCents: integer("amount_cents"),
    paidOn: date("paid_on"),
    // One of the camp's own payment methods (camp_settings.payment_methods).
    method: text("method"),
    flagged: boolean("flagged").default(false).notNull(),
    updatedByPersonId: uuid("updated_by_person_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    campFk("dues_participation_fk", t.participationId, t.campId, participation),
    campFk("dues_updated_by_fk", t.updatedByPersonId, t.campId, person),
    campFk("dues_tier_fk", t.tierId, t.campId, duesTier),
    check("dues_status_ck", sql`${t.status} in ('unpaid','paid','waived')`),
  ],
);

export const INQUIRY_STATUSES = ["new", "contacted", "met", "invited", "declined"] as const;

export const inquiry = pgTable(
  "inquiry",
  {
    id: id(),
    campId: campId(),
    personId: uuid("person_id"),
    name: text("name").notNull(),
    playaName: text("playa_name"),
    email: text("email"),
    phone: text("phone"),
    heardFrom: text("heard_from"),
    note: text("note"),
    status: text("status", { enum: INQUIRY_STATUSES }).default("new").notNull(),
    source: text("source", { enum: ["join_form", "import"] }).notNull(),
    assignedToPersonId: uuid("assigned_to_person_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("inquiry_camp_id_ux").on(t.campId, t.id),
    campFk("inquiry_person_fk", t.personId, t.campId, person),
    campFk("inquiry_assigned_to_fk", t.assignedToPersonId, t.campId, person),
    index("inquiry_email_ix").on(t.campId, t.email),
    check("inquiry_status_ck", sql`${t.status} in ('new','contacted','met','invited','declined')`),
    check("inquiry_source_ck", sql`${t.source} in ('join_form','import')`),
  ],
);

export const inquiryNote = pgTable(
  "inquiry_note",
  {
    id: id(),
    campId: campId(),
    inquiryId: uuid("inquiry_id").notNull(),
    authorPersonId: uuid("author_person_id"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("inquiry_note_inquiry_fk", t.inquiryId, t.campId, inquiry),
    campFk("inquiry_note_author_fk", t.authorPersonId, t.campId, person),
  ],
);

// Append-only. The Worker's database role gets INSERT/SELECT only on this table.
// Platform operators (R41): people who run Theme Camp App, never camp logins. They sign in
// to the console through Cloudflare Access; this table says which Access identities count.
export const operator = pgTable("operator", {
  id: id(),
  email: text("email").notNull().unique(), // lowercased; the email Access asserts
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
});

// What operators did (R41, R42): every console action, and every emergency database access,
// entered by hand. subject_camp_id isn't "camp_id": this is platform-wide, not a camp's table.
// "cli": a command run with the owner connection, like scripts/create-camp.ts (open-source plan
// 3.3), so an instance without the console still has its operator log.
export const OPERATOR_LOG_KINDS = ["console_action", "database_access", "system_job", "cli"] as const;
export const operatorLog = pgTable(
  "operator_log",
  {
    id: id(),
    // Null for what the scheduled jobs did (finishing a camp's deletion, say) and for commands.
    operatorId: uuid("operator_id").references(() => operator.id),
    kind: text("kind", { enum: OPERATOR_LOG_KINDS }).notNull(),
    subjectCampId: uuid("subject_camp_id").references(() => camp.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: text("detail").default("").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "operator_log_kind_ck",
      sql`${t.kind} in ('console_action','database_access','system_job','cli')`,
    ),
    check(
      "operator_log_actor_ck",
      sql`(${t.kind} in ('system_job','cli')) = (${t.operatorId} is null)`,
    ),
    index("operator_log_created_ix").on(t.createdAt),
  ],
);

// Support access (R39, R40): a camp's Admin lets the Theme Camp App operator see the camp,
// read-only, until it expires or an Admin revokes it. The console issues a single-use token
// (stored hashed, good for 60 seconds) that /support/enter on the camp's host exchanges for a
// support cookie (also stored hashed). Camp-owned, under row-level security like the rest.
export const supportGrant = pgTable(
  "support_grant",
  {
    id: id(),
    campId: campId(),
    createdByPersonId: uuid("created_by_person_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByPersonId: uuid("revoked_by_person_id"),
    // When the "support access ended" email went out (revoke, or the first request after expiry).
    endedNotifiedAt: timestamp("ended_notified_at", { withTimezone: true }),
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    tokenUsedAt: timestamp("token_used_at", { withTimezone: true }),
    sessionHash: text("session_hash"),
    openedByOperatorId: uuid("opened_by_operator_id").references(() => operator.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("support_grant_camp_id_ux").on(t.campId, t.id),
    uniqueIndex("support_grant_token_ux").on(t.tokenHash),
    uniqueIndex("support_grant_session_ux").on(t.sessionHash),
    campFk("support_grant_created_by_fk", t.createdByPersonId, t.campId, person),
    campFk("support_grant_revoked_by_fk", t.revokedByPersonId, t.campId, person),
  ],
);

// Data requests during the pilot (R43–R45a): the operator records an export, camp deletion or
// login deletion someone asked for, and nothing happens until the requester confirms it from
// the link emailed to their account's address. Only the link token's hash is stored.
export const DATA_REQUEST_KINDS = ["export", "delete_camp", "delete_login"] as const;
export const dataRequest = pgTable(
  "data_request",
  {
    id: id(),
    campId: campId(),
    kind: text("kind", { enum: DATA_REQUEST_KINDS }).notNull(),
    requesterEmail: text("requester_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByOperatorId: uuid("created_by_operator_id")
      .notNull()
      .references(() => operator.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("data_request_camp_id_ux").on(t.campId, t.id),
    uniqueIndex("data_request_token_ux").on(t.tokenHash),
    check("data_request_kind_ck", sql`${t.kind} in ('export','delete_camp','delete_login')`),
  ],
);

// A full export of a camp (R43), made by the operator on a confirmed request: a zip in the
// bucket under the camp's prefix, listed for its Admins to download for 7 days.
export const campExport = pgTable(
  "camp_export",
  {
    id: id(),
    campId: campId(),
    key: text("key").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("camp_export_camp_id_ux").on(t.campId, t.id)],
);

export const AUDIT_ACTOR_TYPES = ["person", "operator", "system"] as const;

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    campId: campId(),
    // Who did it: a person of this camp, an operator (from the console), or the app itself
    // (no actor). Existing rows are "person" (or no actor, for things the app did).
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).default("person").notNull(),
    actorPersonId: uuid("actor_person_id"),
    actorOperatorId: uuid("actor_operator_id").references(() => operator.id),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("audit_log_actor_fk", t.actorPersonId, t.campId, person),
    check(
      "audit_log_actor_ck",
      sql`(${t.actorType} = 'operator') = (${t.actorOperatorId} is not null) and (${t.actorType} <> 'operator' or ${t.actorPersonId} is null)`,
    ),
    index("audit_log_subject_ix").on(t.campId, t.subjectType, t.subjectId),
    index("audit_log_actor_created_ix").on(t.actorPersonId, t.createdAt),
    index("audit_log_camp_created_ix").on(t.campId, t.createdAt),
  ],
);

// A Lead's CSV import (U17, R31, R32): the parsed rows wait here while the Lead looks at the
// preview; confirming applies them and clears the rows, keeping only the counts. Unconfirmed
// batches are removed after a day.
export const IMPORT_STATUSES = ["pending", "applied"] as const;
export const importBatch = pgTable(
  "import_batch",
  {
    id: id(),
    campId: campId(),
    createdByPersonId: uuid("created_by_person_id").notNull(),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    status: text("status", { enum: IMPORT_STATUSES }).default("pending").notNull(),
    rows: jsonb("rows"),
    summary: jsonb("summary"),
    createdAt: createdAt(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    unique("import_batch_camp_id_ux").on(t.campId, t.id),
    campFk("import_batch_created_by_fk", t.createdByPersonId, t.campId, person),
    check("import_batch_status_ck", sql`${t.status} in ('pending','applied')`),
  ],
);

export const importRecord = pgTable(
  "import_record",
  {
    id: id(),
    campId: campId(),
    sourceKey: text("source_key").notNull(),
    sourceSheet: text("source_sheet").notNull(),
    sourceRow: integer("source_row").notNull(),
    rowHash: text("row_hash").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: uuid("target_id").notNull(),
    batchId: text("batch_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("import_record_camp_source_ux").on(t.campId, t.sourceKey)],
);

export const SEND_STATUSES = [
  "sent",
  "failed",
  "skipped",
  "suppressed",
  "paused",
  "capped",
] as const;

export const sendLog = pgTable(
  "send_log",
  {
    id: id(),
    campId: campId(),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    // Never sent: "skipped" (staging MAIL_ALLOWLIST, or a suspended camp's non-sign-in mail),
    // "suppressed" (the address bounced or complained), "paused" (the camp's sending is
    // paused), "capped" (the camp's daily limit was reached).
    status: text("status", { enum: SEND_STATUSES }).notNull(),
    error: text("error"),
    // The email provider's id for the message, so its bounce or complaint can be
    // traced to this camp.
    providerId: text("provider_id"),
    // Set by the email webhook.
    outcome: text("outcome", { enum: ["bounced", "complained"] }),
    createdAt: createdAt(),
  },
  (t) => [
    index("send_log_recipient_created_ix").on(t.campId, t.recipient, t.createdAt),
    index("send_log_provider_ix").on(t.providerId),
    index("send_log_camp_created_ix").on(t.campId, t.createdAt),
  ],
);

// Platform-wide (no camp_id): addresses that hard-bounced or complained, from any camp. No
// camp's mail goes to them. Written only by the platform Worker's email webhook; the camp
// Worker asks about specific addresses through suppressed_emails().
export const emailSuppression = pgTable(
  "email_suppression",
  {
    email: text("email").primaryKey(), // lowercased
    reason: text("reason", { enum: ["bounce", "complaint"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("email_suppression_reason_ck", sql`${t.reason} in ('bounce','complaint')`)],
);

// Platform-wide: the health alerts the operator has been emailed (U14), one row per problem
// while it lasts. A problem that stays is emailed again only after a day; its row goes when it
// clears, so a new occurrence is emailed at once.
export const platformAlert = pgTable("platform_alert", {
  key: text("key").primaryKey(),
  detail: text("detail").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).defaultNow().notNull(),
});

// R74: what the camp Worker counts as it happens, per camp per day: page views by route id,
// error responses by status and route id, and browser errors by type and route id. Only
// route ids and fixed names, never a URL or anything a person typed. Everything else the
// console shows comes from the audit, sign-in and email logs (camp_usage(), drizzle/0021).
export const usageDaily = pgTable(
  "usage_daily",
  {
    campId: campId(),
    day: date("day").default(sql`current_date`).notNull(),
    metric: text("metric").notNull(),
    count: integer("count").default(1).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.campId, t.day, t.metric] }),
    check("usage_daily_metric_ck", sql`${t.metric} ~ '^[a-z_]+:[A-Za-z0-9_.$/:-]{1,160}$'`),
  ],
);

export const FEEDBACK_ROLES = ["member", "lead", "treasurer", "admin"] as const;

// In-app feedback to the operator (R65). A platform table, not a camp one: there's no camp_id
// column, so camps get no access to it at all (scripts/db-grants.ts). A camp adds to it only
// through submit_feedback() (drizzle/0020), which stamps the camp itself; the console reads it.
// No member identity is kept: the camp, the page (ids removed), the role, the time, the words.
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceCampId: uuid("source_camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    role: text("role", { enum: FEEDBACK_ROLES }).notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // When the operator's "new feedback" email covered it (the platform's hourly job).
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    index("feedback_created_ix").on(t.createdAt),
    check("feedback_role_ck", sql`${t.role} in ('member','lead','treasurer','admin')`),
    check("feedback_message_ck", sql`length(${t.message}) between 1 and 4000`),
    check("feedback_path_ck", sql`${t.path} like '/%' and length(${t.path}) <= 200`),
  ],
);

// Issue #73: camps asking to join, from the public sign-up page (<domain>/signup). The
// operator approves one in the console, which creates the camp and invites its Admins, or
// declines it. Organizers' contact details given to Theme Camp App directly, not a camp's
// data (so no camp_id: the platform Worker alone reads it). Removed 90 days after a decision.
export const SIGNUP_STATUSES = ["pending", "approved", "declined"] as const;
export type SignupAdmin = { name: string; email: string };
export const CAMP_SIZES = ["under_25", "25_50", "50_100", "over_100"] as const;
export const campSignup = pgTable(
  "camp_signup",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campName: text("camp_name").notNull(),
    slug: text("slug").notNull(),
    admins: jsonb("admins").$type<SignupAdmin[]>().notNull(),
    seasonYear: integer("season_year").notNull(),
    campSize: text("camp_size"),
    note: text("note"),
    status: text("status", { enum: SIGNUP_STATUSES }).default("pending").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByOperatorId: uuid("decided_by_operator_id").references(() => operator.id),
    createdCampId: uuid("created_camp_id").references(() => camp.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("camp_signup_status_ix").on(t.status, t.createdAt),
    check("camp_signup_status_ck", sql`${t.status} in ('pending','approved','declined')`),
    check("camp_signup_name_ck", sql`char_length(${t.campName}) between 1 and 80`),
    check("camp_signup_slug_ck", sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'`),
    check(
      "camp_signup_admins_ck",
      sql`jsonb_typeof(${t.admins}) = 'array' and jsonb_array_length(${t.admins}) between 1 and 5`,
    ),
    check(
      "camp_signup_size_ck",
      sql`${t.campSize} is null or ${t.campSize} in ('under_25','25_50','50_100','over_100')`,
    ),
    check("camp_signup_note_ck", sql`${t.note} is null or char_length(${t.note}) <= 1000`),
    check("camp_signup_decided_ck", sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
  ],
);

// Email webhook deliveries already handled, by the provider's event id (Plunk's workflow
// execution id; "postmark:<record type>:<id>" for Postmark), so a repeat changes nothing.
export const emailWebhookEvent = pgTable("email_webhook_event", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

export const LEAD_QUEUE_KINDS = [
  "link_conflict",
  "shared_email",
  "no_email",
  "email_change_conflict",
  "send_failure",
] as const;

export const leadQueueItem = pgTable(
  "lead_queue_item",
  {
    id: id(),
    campId: campId(),
    kind: text("kind", { enum: LEAD_QUEUE_KINDS }).notNull(),
    personId: uuid("person_id"),
    authUserId: text("auth_user_id"),
    payload: jsonb("payload"),
    status: text("status", { enum: ["open", "resolved"] })
      .default("open")
      .notNull(),
    resolvedByPersonId: uuid("resolved_by_person_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("lead_queue_item_person_fk", t.personId, t.campId, person),
    campFk("lead_queue_item_resolved_by_fk", t.resolvedByPersonId, t.campId, person),
    check(
      "lead_queue_kind_ck",
      sql`${t.kind} in ('link_conflict','shared_email','no_email','email_change_conflict','send_failure')`,
    ),
    check("lead_queue_status_ck", sql`${t.status} in ('open','resolved')`),
  ],
);

// A member's pending sign-in email change. The link goes to the new address; only the hash of
// its single-use token is stored. Confirming (a POST) swaps the login and person email.
export const emailChange = pgTable(
  "email_change",
  {
    id: id(),
    campId: campId(),
    personId: uuid("person_id").notNull(),
    newEmail: text("new_email").notNull(),
    // Two steps (security review S4). The current sign-in address approves first, with this
    // token; only then is the new address sent its own token to confirm.
    approveTokenHash: text("approve_token_hash").unique(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    tokenHash: text("token_hash").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("email_change_person_fk", t.personId, t.campId, person),
    index("email_change_person_ix").on(t.personId),
  ],
);

// Per-camp settings stored by key (Admins' email wording: "email_template:<kind>").
export const appSetting = pgTable(
  "app_setting",
  {
    campId: campId(),
    key: text("key").notNull(),
    value: jsonb("value"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: "app_setting_pk", columns: [t.campId, t.key] })],
);

// Sign-in troubleshooting log: each step of the sign-in flow, for Admins (/admin/logs).
// Kept 90 days. Never holds tokens or links.
export const authEvent = pgTable(
  "auth_event",
  {
    id: id(),
    campId: campId(),
    event: text("event").notNull(),
    email: text("email"),
    // ON DELETE SET NULL (person_id) only: written by hand in drizzle/0002_*, since drizzle
    // can't express the column list and a plain SET NULL would null camp_id too.
    personId: uuid("person_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (t) => [
    campFk("auth_event_person_fk", t.personId, t.campId, person),
    index("auth_event_created_ix").on(t.campId, t.createdAt),
    index("auth_event_email_created_ix").on(t.campId, t.email, t.createdAt),
  ],
);
