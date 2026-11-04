// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Turns the {reason} responses thrown by server helpers into sentences for forms.
const MESSAGES: Record<string, string> = {
  not_found: "That person doesn't exist.",
  inactive: "This person is deactivated. Reactivate them first.",
  inactive_person: "This person is deactivated. Reactivate them first.",
  already_signed_in: "They've already signed in; no invite needed.",
  no_email: "Add a valid email address before inviting.",
  shared_email:
    "Another active person has the same email. Fix one of them first (see the Lead queue).",
  invite_rate_limited: "This invite has been sent 3 times today. Try again tomorrow.",
  send_failed: "The email didn't send. It's logged; try again in a few minutes.",
  daily_limit: "This camp has reached today's email limit. Try again tomorrow.",
  sending_paused:
    "This camp's email is paused while bounces or spam reports are looked into. Nothing was sent.",
  invalid_email: "That email address doesn't look right.",
  email_in_use:
    "Another active person already has that email. Use their record instead (search People).",
  linked_email_locked:
    "They've signed in, so their sign-in email can't be changed here. Unlink their login and re-invite them if it's wrong.",
  last_admin: "That would leave the camp with no active Admin.",
  leaving_last_admin:
    "You're the camp's only Admin. Make someone else an Admin first (People → their page), then leave.",
  admin_only: "Only an Admin can do that.",
  forbidden: "You don't have access to do that.",
  // Issue #93: the camp's roles.
  role_archived: "That role has been archived, so it can't be given to anyone.",
  role_name_needed: "Give the role a name.",
  role_name_too_long: "Keep the role's name to 40 characters.",
  role_name_reserved: "Member, Lead, Treasurer and Admin are already roles. Pick another name.",
  role_name_taken: "There's already a role with that name.",
  role_description_too_long: "Keep the description to 200 characters.",
  too_many_roles: "A camp can have up to 20 custom roles. Archive one you don't use first.",
  more_access:
    "This person can do things you can't, so only an Admin (or someone with at least their access) can do that.",
  camp_name_needed: "Give the camp a name.",
  camp_name_too_long: "Keep the camp's name under 60 characters.",
  camp_name_link: "The camp's name can't look like a web address.",
  accent_not_a_colour: "That colour doesn't look right. Use a hex code like #9db4cc.",
  accent_too_dark:
    "Dark text wouldn't be readable on that colour. Pick a lighter one (buttons use it as a background).",
  notify_email_invalid: "One of the inquiry notification addresses doesn't look right.",
  max_tickets_range: "The most tickets a camper can request must be from 1 to 10.",
  payment_methods_needed: "List at least one way campers can pay dues.",
  sap_date_needed: "Pick the day these passes are for.",
  sap_serial_needed: "Enter at least one serial number.",
  sap_serial_too_long: "That doesn't look like a serial number (too long).",
  sap_pass_assigned: "That pass is assigned to someone. Release it first.",
  sap_pdf_missing: "Choose the pass's PDF first.",
  sap_pdf_too_large: "That PDF is too big (5 MB max).",
  sap_pdf_bad_type: "That isn't a PDF file.",
  sap_not_requested: "They haven't requested a SAP (or aren't coming), so it can't be approved.",
  sap_pass_taken: "That pass was just given to someone else. Pick another.",
  sap_day_needed: "Pick the day to approve them for, or a pass.",
  sap_day_not_offered:
    "That isn't one of this season's SAP days. An Admin can add it under Admin → SAPs.",
  sap_too_many_days: "That's a lot of SAP days (21 max).",
  role_full: "That job is full. Ask a camp lead if you'd still like to help with it.",
  job_assigned_only: "Leads fill that job. Ask one of them about it.",
  role_title_needed: "Give the job a name.",
  role_bad_slots: "Spots must be a whole number from 1 to 50.",
  season_changed:
    "The season has already changed (someone else may have rolled over). Reload and check.",
  bad_season: "That season doesn't exist.",
  use_invite: "Use the Invite button to mark someone invited.",
  rsvp_first: "RSVP as Going or Leaning yes first, then request tickets.",
  tickets_over_limit: "That's more tickets than this camp allows per person.",
  requests_locked:
    "Ticket requests are locked while Leads finalize the Stewards Sale. Ask a Lead if something changed.",
  bad_status: "Unknown status.",
  photo_missing: "Choose a photo first.",
  logo_missing: "Choose a logo image first.",
  announcement_title_needed: "Give the announcement a title.",
  announcement_title_too_long: "Keep the title under 120 characters.",
  announcement_body_too_long: "Keep the message under 4,000 characters.",
  announcement_date_needed: "Choose the last day it should show.",
  announcement_date_past: "The last day to show it can't be in the past.",
  announcement_date_too_far: "Announcements can show for 30 days at most. Choose an earlier day.",
  announcement_not_found: "That announcement has already come down.",
  announcement_duplicate: "That announcement is already on the home page.",
  past_season_range: "Choose a year from 1996 up to last year.",
  past_season_exists: "That season is already set up.",
  past_season_in_use:
    "That season has records in it (who camped, or people in jobs), so it can't be removed. Untick everyone first.",
  volunteer_max_reached:
    "You've signed up for as many jobs as this camp allows. Leave one to pick another, or ask a Lead.",
  volunteer_bad_max: "The most jobs per member must be a whole number from 1 to 20, or blank.",
  feedback_message_needed: "Write something to send.",
  feedback_too_long: "Keep feedback under 4,000 characters.",
  feedback_rate_limited:
    "A lot of feedback has come from this camp in the last hour. Try again later.",
  feedback_not_here: "Feedback can't be sent from here.",
  key_date_label_needed: "Say what the date is for.",
  key_date_label_too_long: "Keep the description under 80 characters.",
  key_date_date_needed: "Choose a date.",
  key_date_action_unknown: "Choose what the date is tied to.",
  key_date_not_found: "That date has already been removed.",
  support_duration_needed: "Choose how long support can see the camp.",
  guide_not_found: "That guide doesn't exist any more. It may have been deleted.",
  guide_title_needed: "Give the guide a title.",
  guide_title_too_long: "Keep the title under 120 characters.",
  guide_summary_too_long: "Keep the summary under 300 characters.",
  guide_body_too_long: "That guide is too long (50,000 characters max). Split it into two.",
  guide_visibility_needed: "Choose who can read the guide.",
  guide_unpublish_first: "Unpublish the guide before deleting it.",
  import_not_csv:
    "That doesn't look like a CSV file. In your spreadsheet, choose File → Download (or Export) → CSV.",
  import_empty: "That file has no people in it: a heading row, then one row per person.",
  import_too_big: "That file is over 1 MB. Split it into smaller files.",
  import_too_many_rows: "That file has more than 2,000 people. Split it into smaller files.",
  import_no_name_column:
    'The file needs a "Name" column. Start from the template, or rename your heading to "Name".',
  import_not_found:
    "That import doesn't exist any more. Unconfirmed imports are removed after a day.",
  import_done: "That import has already been done.",
  starter_already_copied:
    "The camp already has a guide at that address. Edit it, or delete it first to start again from the ready-made one.",
  logo_too_large: "That image is too big (2 MB max). Try a smaller one.",
  logo_bad_type: "Please upload a JPEG, PNG, WebP or HEIC image. SVG isn't accepted.",
  logo_processing_failed: "We couldn't process that image right now. Please try again in a bit.",
  photo_too_large: "That photo is too big (5 MB max). Try a smaller one.",
  photo_bad_type: "Please upload a JPEG, PNG, WebP or HEIC photo.",
  photo_rate_limited: "That's a lot of uploads today. Try again tomorrow.",
  photo_processing_failed: "We couldn't process that photo right now. Please try again in a bit.",
  bad_camp_year: "That year can't be changed here.",
  bad_amount: "Enter an amount in dollars, like 150 or 150.00.",
  dues_amount_needed: "Enter the amount paid (or set the dues amount for the year first).",
  dues_date_needed: "Enter the date it was paid.",
  dues_method_needed: "Choose how it was paid.",
  same_email: "That's already your sign-in email.",
  email_unavailable:
    "That address can't be used. If it's yours, ask a camp lead; they've been told.",
  email_change_rate_limited: "That's a lot of email changes today. Try again tomorrow.",
  email_change_invalid:
    "That link has expired or was already used. Request a new one from your profile.",
  dues_tier_name_needed: "Give the tier a name (up to 60 characters).",
  dues_tier_amount_needed: "Enter the tier's amount in dollars, like 150.",
  dues_tier_name_taken: "There's already a tier with that name this year.",
  dues_tier_unknown: "That dues tier isn't set up for this year.",
  dues_not_coming: "They aren't Going or Leaning yes this year, so they don't owe dues.",
};

export function reasonOf(e: unknown): string | null {
  const reason = (e as { data?: { reason?: unknown } })?.data?.reason;
  return typeof reason === "string" ? reason : null;
}

// Returns a form error for known refusals; rethrows anything unexpected.
export function formError(e: unknown): { error: string } {
  const reason = reasonOf(e);
  if (reason && MESSAGES[reason]) return { error: MESSAGES[reason] };
  throw e;
}
