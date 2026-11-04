// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatCents } from "./dues";
import { EDITABLE } from "./email-templates";

// Turns an audit_log row about a person into one readable line for their History.
// Shared (no server imports) so it can be unit-tested and used anywhere.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

const INTENT: Record<string, string> = {
  going: "Going",
  leaning_yes: "Leaning yes",
  leaning_no: "Leaning no",
  not_going: "Not going",
};
const ROLE: Record<string, string> = { lead: "Lead", treasurer: "Treasurer", admin: "Admin" };
// A role as a sentence names it: "Lead", or a custom role's name in quotes.
const roleName = (v: unknown) => ROLE[String(v)] ?? (str(v) ? `the “${v}” role` : "a role");
const FIELD: Record<string, string> = {
  legalName: "name",
  playaName: "playa name",
  phone: "phone",
  homeLocation: "home location",
  mailingAddress: "mailing address",
  email: "email",
  arrivalDate: "arrival",
  departureDate: "departure",
  dwellingDescription: "dwelling",
  dwellingSize: "dwelling size",
  generator: "generator",
  sapRequested: "SAP request",
  sapDate: "SAP day",
  earlyAccessNeeded: "early access",
};

// The fields whose values differ between before and after, as words.
function changed(before: unknown, after: unknown): string {
  const b = obj(before);
  const a = obj(after);
  const keys = Object.keys(a).filter(
    (k) => FIELD[k] && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null),
  );
  return [...new Set(keys.map((k) => FIELD[k]))].join(", ");
}

const day = (iso: unknown) => {
  const s = str(iso);
  if (!s) return null;
  return new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

const INQUIRY: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  met: "Met",
  invited: "Invited",
  declined: "Declined",
};
const templateName = (kind: string | null | undefined) =>
  EDITABLE.find((t) => t.kind === kind)?.name ?? String(kind ?? "an").replace(/_/g, " ");

const CAMP_YEAR: Record<string, string> = { true: "Came", false: "Didn't come", null: "Unknown" };

// `ctx` carries names the caller looked up: the subject (a position, role, inquiry…) and,
// for inquiries, who they were assigned to.
export function describeHistory(
  action: string,
  before: unknown,
  after: unknown,
  ctx: { view?: "person" | "activity"; subject?: string | null; assignee?: string | null } = {},
): string {
  const a = obj(after);
  const b = obj(before);
  switch (action) {
    case "person_created":
      return a.fromInquiry ? "Added from a join inquiry" : "Added";
    case "person_updated": {
      const c = changed(before, after);
      return c ? `Details edited: ${c}` : "Details edited";
    }
    case "profile_updated": {
      const c = changed(before, after);
      return c ? `Profile edited: ${c}` : "Profile edited";
    }
    case "invite_sent":
      return str(a.email) ? `Invite sent to ${a.email}` : "Invite sent";
    case "invite_resent":
      return str(a.email) ? `Invite re-sent to ${a.email}` : "Invite re-sent";
    case "bulk_invite_sent":
      return ctx.view === "activity" && typeof a.count === "number"
        ? `Sent bulk invites to ${a.count} people`
        : "Invited (bulk invite)";
    case "account_linked":
      return "Signed in for the first time";
    case "email_change_requested":
      return str(a.newEmail) ? `Asked to change email to ${a.newEmail}` : "Asked to change email";
    case "email_change_approved":
      return "Approved the email change from their current address";
    case "email_changed":
    case "email_changed_by_lead":
      return str(b.email) && str(a.email)
        ? `Email changed: ${b.email} → ${a.email}`
        : "Email changed";
    case "login_unlinked":
      return "Login unlinked";
    case "role_granted":
      return a.role === "custom"
        ? `Given the “${str(a.name) ?? "custom"}” role`
        : `Made ${ROLE[String(a.role)] ?? String(a.role ?? "a role")}`;
    case "role_revoked":
      return b.role === "custom"
        ? `“${str(b.name) ?? "Custom"}” role removed`
        : `${ROLE[String(b.role)] ?? String(b.role ?? "Role")} role removed`;
    // Issue #93: the camp's roles themselves (Admin → Roles).
    case "role_defined":
      return `Created the “${str(a.name) ?? "new"}” role`;
    case "role_updated":
      return `Changed what ${roleName(a.name)} can do`;
    case "role_reset":
      return `Reset ${roleName(b.name)} to the defaults`;
    case "roles_reviewed":
      return "Confirmed the camp's roles look right";
    case "role_archived":
      return `Archived the “${str(b.name) ?? "custom"}” role`;
    case "person_deactivated":
      return "Deactivated";
    case "person_reactivated":
      return "Reactivated";
    case "person_left":
      return "Left the camp";
    case "camp_settings_saved":
      return "Camp settings saved";
    case "features_saved":
      return "Features changed";
    case "support_granted":
      return `Support access granted for ${a.hours} hours (read-only)`;
    case "support_revoked":
      return "Support access ended early";
    case "support_expired":
      return "Support access ran out";
    case "support_opened":
      return "Support opened the camp";
    case "support_view":
      return `Support viewed ${a.path}`;
    case "camp_suspended":
      return `Camp suspended. Reason: ${a.reason}`;
    case "camp_restored":
      return `Camp restored. Note: ${a.reason}`;
    case "announcement_posted":
      return `Announcement posted: ${a.title}`;
    case "announcement_edited":
      return `Announcement edited: ${a.title}`;
    case "announcement_emailed":
      return `Announcement emailed to ${a.sent} of ${a.recipients}: ${a.title}`;
    case "announcement_removed":
      return `Announcement removed: ${b.title}`;
    case "key_date_added":
      return `Key date added: ${a.label} (${a.date})`;
    case "key_date_reminded":
      return `Reminder emailed for ${a.label} (${a.date}) to ${a.sent} of ${a.recipients}`;
    case "key_date_edited":
      return `Key date changed: ${a.label} (${a.date})`;
    case "key_date_removed":
      return `Key date removed: ${b.label} (${b.date})`;
    case "guide_created":
      return `Guide started: ${a.title ?? ""}`;
    case "guide_saved":
      return `Guide edited: ${a.title ?? ""}`;
    case "guide_published":
      return `Guide published: ${a.title ?? ""}`;
    case "guide_unpublished":
      return `Guide unpublished: ${a.title ?? ""}`;
    case "guides_reordered":
      return `Guides reordered (${a.title ?? "a guide"} moved)`;
    case "guide_deleted":
      return `Guide deleted: ${b.title ?? ""}`;
    case "camp_logo_saved":
      return "Camp logo changed";
    case "camp_logo_removed":
      return "Camp logo removed";
    case "bootstrap_first_lead":
      return "Made the first Lead";
    case "camp_year_set":
      return a.year
        ? `Camp year ${a.year} set to ${CAMP_YEAR[String(a.attended ?? null)]}${a.via === "rollover" ? " (season rollover)" : ""}`
        : "Camp year changed";
    case "directory_choice":
      return a.share ? "Chose to be listed in the directory" : "Chose not to be in the directory";
    case "rsvp_updated": {
      const intent = str(a.intent);
      if (intent && intent !== b.intent) return `RSVP: ${INTENT[intent] ?? intent}`;
      const c = changed(before, after);
      return c ? `RSVP updated: ${c}` : "RSVP updated";
    }
    case "rsvp_nudge_sent":
      return ctx.view === "activity" && Array.isArray(a.personIds) && a.personIds.length > 1
        ? `Sent RSVP reminders to ${a.personIds.length} people`
        : "Sent an RSVP reminder";
    case "ticket_request_saved": {
      if (a.hasTicketElsewhere) return "Ticket request: has a ticket already";
      const n = Number(a.ticketsNeeded ?? 0);
      const parts = [`${n} ${n === 1 ? "ticket" : "tickets"}`];
      if (a.vehiclePassNeeded) parts.push("a vehicle pass");
      return `Ticket request: ${parts.join(" and ")}`;
    }
    case "dues_updated": {
      const status = String(a.status ?? "");
      const amount = typeof a.amountCents === "number" ? ` (${formatCents(a.amountCents)})` : "";
      return status === "paid"
        ? `Dues recorded as paid${amount}`
        : status === "waived"
          ? "Dues waived"
          : "Dues marked unpaid";
    }
    case "position_assigned":
      return `Elected ${a.position ?? "to a position"}${a.year ? ` for ${a.year}` : ""}`;
    case "position_unassigned":
      return `Removed from ${b.position ?? "a position"}${b.year ? ` for ${b.year}` : ""}`;
    // Issue #106: volunteer roles are jobs. Older entries read the same way.
    case "volunteer_signed_up":
      return `Took the job ${a.role ?? "a job"}`;
    case "volunteer_left":
      return `Left the job ${b.role ?? "a job"}`;
    case "photo_updated":
      return "Photo updated";
    case "photo_removed":
      return "Photo removed";
    case "photo_removed_by_lead":
      return "Photo removed by a Lead";
    case "sap_approved": {
      const d = day(a.day);
      const serial = str(a.serial) ? `, pass ${a.serial}` : "";
      return `SAP approved${d ? ` for ${d}` : ""}${serial}`;
    }
    case "sap_denied":
      return "SAP request denied";
    case "sap_decision_undone":
      return "SAP decision undone";
    case "sap_pass_released":
      return "SAP pass taken back";
    case "sap_pass_auto_released": {
      const serials =
        Array.isArray(a.serials) && a.serials.length ? ` ${a.serials.join(", ")}` : "";
      return a.reason === "deactivated"
        ? `SAP pass${serials} released automatically (deactivated)`
        : `SAP pass${serials} released automatically (RSVP changed)`;
    }
    case "inquiry_invited":
      return a.alreadyMember
        ? "Join inquiry closed: already a member"
        : "Invited from their join inquiry";
    case "inquiry_closed_existing":
      return "Join inquiry closed: already a camper";
    case "inquiry_updated": {
      const parts: string[] = [];
      if (a.status && a.status !== b.status) {
        parts.push(
          `Status: ${INQUIRY[String(b.status)] ?? b.status ?? "?"} → ${INQUIRY[String(a.status)] ?? a.status}`,
        );
      }
      if ("assignedToPersonId" in a && a.assignedToPersonId !== b.assignedToPersonId) {
        parts.push(a.assignedToPersonId ? `Assigned to ${ctx.assignee ?? "a Lead"}` : "Unassigned");
      }
      return parts.join("; ") || "Inquiry updated";
    }

    // Camp-wide changes (Admin → Activity).
    case "season_rolled_over":
      return `Rolled the season over: ${b.year} → ${a.year} (${a.came ?? 0} came, ${a.didNotCome ?? 0} didn't)`;
    case "season_switched":
      return `Switched the current season: ${b.year} → ${a.year}`;
    case "dues_settings_updated": {
      const parts: string[] = [];
      if (a.amountCents !== b.amountCents && typeof a.amountCents === "number") {
        parts.push(`amount ${formatCents(a.amountCents)}`);
      }
      if (a.instructions !== b.instructions) parts.push("payment instructions");
      return parts.length ? `Dues settings changed: ${parts.join(", ")}` : "Dues settings saved";
    }
    case "ticket_requests_locked":
      return "Locked ticket requests";
    case "ticket_requests_unlocked":
      return "Unlocked ticket requests";
    case "past_season_added":
      return `Past season added: ${a.year}`;
    case "past_season_removed":
      return `Past season removed: ${b.year}`;
    case "volunteer_max_set":
      return a.max == null ? "Jobs per member: no limit" : `Jobs per member: at most ${a.max}`;
    case "page_text_saved":
      return `Page wording changed: ${a.name}`;
    case "page_text_reset":
      return `Page wording reset to the default: ${b.name}`;
    case "email_template_saved":
      return `Edited the ${templateName(ctx.subject)} email`;
    case "email_template_reset":
      return `Reset the ${templateName(ctx.subject)} email to the default wording`;
    case "sap_days_set": {
      const days = Array.isArray(a.days) ? a.days.map(day).filter(Boolean) : [];
      return days.length ? `SAP days set: ${days.join(", ")}` : "SAP days cleared";
    }
    case "sap_passes_added": {
      const n = Array.isArray(a.serials) ? a.serials.length : 0;
      return `Added ${n} SAP ${n === 1 ? "pass" : "passes"} for ${day(a.date) ?? "a day"}`;
    }
    case "sap_pass_deleted":
      return `Deleted SAP pass ${b.serial ?? ""}`.trim();
    case "sap_pdf_uploaded":
      return `Uploaded the PDF for SAP pass ${a.serial ?? ""}`.trim();
    case "sap_pdf_removed":
      return "Removed a SAP pass PDF";
    case "position_added":
      return `Added the position ${a.title ?? ctx.subject ?? ""}`.trim();
    case "position_renamed":
      return `Renamed a position: ${b.title} → ${a.title}`;
    case "position_retired":
      return `Retired the position ${ctx.subject ?? ""}`.trim();
    case "position_restored":
      return `Restored the position ${ctx.subject ?? ""}`.trim();
    case "volunteer_role_added":
      return `Added the job ${a.title ?? ctx.subject ?? ""}`.trim();
    case "volunteer_role_updated":
      return `Edited the job ${a.title ?? ctx.subject ?? ""}`.trim();
    case "volunteer_role_retired":
      return `Retired the job ${ctx.subject ?? ""}`.trim();
    case "volunteer_role_restored":
      return `Restored the job ${ctx.subject ?? ""}`.trim();
    case "people_imported":
      return `Imported people from ${a.file ?? "a CSV file"} (${a.created ?? 0} added, ${a.updated ?? 0} updated)`;
    case "roster_exported":
      return `Exported a Roster view (${a.rows ?? "?"} people${a.dues ? ", with dues" : ""})`;
    case "people_exported":
      return `Exported the People list (${a.rows ?? "?"} people${a.dues ? ", with dues" : ""})`;
    case "queue_item_resolved":
      return "Resolved a Lead queue item";
    case "import_applied":
      return "Applied the 2026 spreadsheet import";
    case "history_import_applied":
      return "Applied the 2024–2025 history import";
    default:
      return action.replace(/_/g, " ");
  }
}

// Everything recorded in audit_log, for Admins (/admin/activity), grouped into areas.
export const ACTIVITY_AREAS = {
  people: "People",
  inquiries: "Join inquiries",
  season: "Season & settings",
  saps: "SAPs",
  roles: "Roles & jobs",
  other: "Imports, exports & other",
} as const;
export type ActivityArea = keyof typeof ACTIVITY_AREAS;
