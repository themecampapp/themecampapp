// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Email wording, shared by the server (sending) and the Admin editor (preview). Admins can
// override the subject and body of the editable kinds; the sign-in link email and the Lead
// notification stay fixed. Templates are plain text with the placeholders {link}, {year} and
// {camp} (the camp's name), plus {day} where noted.
// Nothing a visitor typed is ever put into an email.

import type { FeatureKey } from "./features";
import { looksLikeLink } from "./links";

export type MailKind =
  | "magic_link"
  | "invite"
  | "inquiry_confirmation"
  | "inquiry_notify"
  | "photo_removed"
  | "email_change_approve"
  | "email_change_verify"
  | "email_changed_notice"
  | "rsvp_nudge"
  | "sap_approved"
  | "sap_ready"
  | "support_granted"
  | "support_ended"
  | "announcement"
  | "date_reminder"
  | "feedback_received";

export type TemplateText = { subject: string; body: string };

// Account email (sign-in links, email changes) goes from its own sending subdomain, so camp
// traffic can't hurt its reputation, and it still goes while a camp is suspended or paused.
export const ACCOUNT_KINDS: ReadonlySet<MailKind> = new Set([
  "magic_link",
  "email_change_approve",
  "email_change_verify",
  "email_changed_notice",
]);

// Mail a Lead sends to many people at once counts against the camp's daily limit (R14).
export const CAPPED_KINDS: ReadonlySet<MailKind> = new Set([
  "invite",
  "rsvp_nudge",
  "announcement",
  "date_reminder",
]);

// Why the recipient is getting each email (R34), for the fixed footer.
const REASON: Record<MailKind, string> = {
  magic_link: "someone asked to sign in to {camp} with this address",
  invite: "a camp lead invited you to {camp}'s camp app",
  inquiry_confirmation: "someone used {camp}'s join page with this address",
  inquiry_notify: "you're on {camp}'s list for new inquiries",
  photo_removed: "you're a member of {camp}",
  email_change_approve: "this is the sign-in address of your {camp} account",
  email_change_verify: "someone asked to use this address to sign in to {camp}",
  email_changed_notice: "this was the sign-in address of your {camp} account",
  rsvp_nudge: "you're on {camp}'s camp list",
  sap_approved: "you asked {camp} for a Setup Access Pass",
  sap_ready: "you asked {camp} for a Setup Access Pass",
  support_granted: "you're an Admin of {camp}",
  support_ended: "you're an Admin of {camp}",
  announcement: "you're on {camp}'s camp list this year",
  date_reminder: "you're on {camp}'s camp list this year",
  feedback_received: "you sent feedback from {camp}'s camp app",
};

// Appended to every email, after the (possibly edited) body. Admins can't change it.
// `product` is the instance's name (PRODUCT_NAME, open-source plan 3.5).
export function footer(kind: MailKind, camp: string, product: string) {
  const reason = REASON[kind].replaceAll("{camp}", camp);
  return `\n\n--\nSent by ${camp} through ${product}. You're getting this because ${reason}.`;
}
export type Placeholder = "link" | "year" | "day" | "camp";

export const DEFAULT_TEMPLATES: Record<MailKind, TemplateText> = {
  magic_link: {
    subject: "Your {camp} sign-in link",
    body: [
      "Here's your link to sign in to the {camp} camp app:",
      "",
      "{link}",
      "",
      "It works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.",
    ].join("\n"),
  },
  invite: {
    subject: "You're invited to the {camp} camp app",
    body: [
      "You've been invited to the {camp} camp app, where we plan the {year} burn:",
      "RSVP, tickets, dues, and more.",
      "",
      "Sign in here with this email address:",
      "{link}",
    ].join("\n"),
  },
  inquiry_confirmation: {
    subject: "Thanks for your interest in {camp}",
    body: [
      "Thanks for reaching out to {camp}!",
      "",
      "We got your note. A camp lead will get in touch to say hello and answer any questions.",
      "",
      "If you didn't send this, you can ignore this email.",
    ].join("\n"),
  },
  photo_removed: {
    subject: "Your {camp} yearbook photo was removed",
    body: [
      "A camp lead removed your profile photo from the {camp} yearbook, usually because",
      "it didn't fit the photo guidelines (a head-and-shoulders shot of just you).",
      "",
      "You can add a new one any time from your profile: {link}",
    ].join("\n"),
  },
  email_change_approve: {
    subject: "Approve changing your {camp} sign-in email",
    body: [
      "Someone signed in to your {camp} camp app account asked to change the email address",
      "you sign in with.",
      "",
      "If that was you, open this link to see the new address and approve it:",
      "{link}",
      "",
      "Then confirm from the new address. Nothing changes until both are done.",
      "",
      "If it wasn't you, don't approve it. Someone may be signed in as you: tell a camp lead.",
    ].join("\n"),
  },
  email_change_verify: {
    subject: "Confirm your new {camp} sign-in email",
    body: [
      "Someone asked to use this address for signing in to the {camp} camp app.",
      "",
      "To confirm, open this link and press the button:",
      "{link}",
      "",
      "It works once and expires in 24 hours. If you didn't ask for this, ignore this email",
      "and nothing changes.",
    ].join("\n"),
  },
  email_changed_notice: {
    subject: "Your {camp} sign-in email was changed",
    body: [
      "The sign-in email for your {camp} camp app account was just changed, so",
      "sign-in links now go to the new address instead of this one.",
      "",
      "If you didn't do this, contact a camp lead right away so they can fix it.",
      "",
      "{link}",
    ].join("\n"),
  },
  rsvp_nudge: {
    subject: "Are you coming to {camp} in {year}?",
    body: [
      "We're starting to plan {camp} {year}, and we'd really love to know if you're coming.",
      "",
      "It only takes a minute: sign in and tell us Going, Leaning yes, Leaning no or Not going.",
      "Not sure yet is fine too. Leaning either way helps us plan.",
      "",
      "Sign in with this email address: {link}",
      "",
      "Thanks! We hope to see you out there.",
    ].join("\n"),
  },
  sap_approved: {
    subject: "Your Setup Access Pass is approved",
    body: [
      "Good news: your Setup Access Pass (SAP) request is approved for {day}.",
      "",
      "We'll email you again when your pass is ready to download and print. Check the camp",
      "app's guides and ask a camp lead about what build week involves.",
      "",
      "Sign in here: {link}",
    ].join("\n"),
  },
  sap_ready: {
    subject: "Your Setup Access Pass is ready to print",
    body: [
      "Your Setup Access Pass (SAP) for {day} is ready.",
      "",
      "Sign in to the camp app and download it from your home page, then print it.",
      "You need the printed pass at the gate, or you can't come in early.",
      "",
      "Sign in here: {link}",
    ].join("\n"),
  },
  support_granted: {
    subject: "{product} support can now see {camp}",
    body: [
      "An Admin of {camp} gave {product} support read-only access to the camp's site",
      "until {day}. Every page support looks at is listed in the camp's Activity.",
      "",
      "Any Admin can end it early here: {link}",
    ].join("\n"),
  },
  support_ended: {
    subject: "{product} support's access to {camp} has ended",
    body: [
      "{product} support can no longer see {camp}'s site.",
      "",
      "What support looked at is listed in the camp's Activity: {link}",
    ].join("\n"),
  },
  inquiry_notify: {
    subject: "New {camp} inquiry",
    body: ["Someone asked about joining {camp}.", "", "Open it here: {link}"].join("\n"),
  },
  // Built from what a Lead wrote (link-stripped), not from this wording: see
  // app/lib/data/announcements.server.ts and app/lib/data/reminders.server.ts.
  announcement: { subject: "News from {camp}", body: "Read it on the camp site: {link}" },
  date_reminder: { subject: "A reminder from {camp}", body: "See the camp site: {link}" },
  // R65. Fixed wording; it never repeats what the member wrote.
  feedback_received: {
    subject: "Thanks for your feedback on {product}",
    body: [
      "{product} got the feedback you sent from {camp}'s camp app. The person who runs",
      "{product} reads every message. Your camp's Leads don't see it.",
      "",
      "Back to the camp app: {link}",
    ].join("\n"),
  },
};

// The templates Admins can edit, in the order the editor lists them. `required` placeholders
// must stay in the body (without {link} the email would be useless).
export const EDITABLE: Array<{
  kind: MailKind;
  name: string;
  when: string;
  link: string;
  required: Placeholder[];
  extra?: Placeholder[]; // placeholders beyond {link}, {year} and {camp} this email may use
  feature?: FeatureKey; // listed only while the camp has this feature on
}> = [
  {
    kind: "invite",
    name: "Invite",
    when: "A Lead invites someone (one at a time or in bulk).",
    link: "the sign-in page, with their email filled in",
    required: ["link"],
  },
  {
    kind: "rsvp_nudge",
    name: "RSVP nudge",
    when: "A Lead sends an RSVP nudge from the Roster or a person's page.",
    link: "the sign-in page, with their email filled in",
    required: ["link"],
  },
  {
    kind: "inquiry_confirmation",
    feature: "join",
    name: "Join form confirmation",
    when: "Someone fills in the Join page.",
    link: "(no link)",
    required: [],
  },
  {
    kind: "photo_removed",
    name: "Photo removed",
    when: "A Lead removes someone's Yearbook photo.",
    link: "their profile page",
    required: [],
  },
  {
    kind: "email_change_verify",
    name: "Confirm new email",
    when: "A member asks to change their sign-in email (sent to the new address).",
    link: "the confirmation page (single use, 24 hours)",
    required: ["link"],
  },
  {
    kind: "email_changed_notice",
    name: "Email changed notice",
    when: "A member's sign-in email changes (sent to the old address).",
    link: "the camp app",
    required: [],
  },
  {
    kind: "sap_approved",
    feature: "saps",
    name: "SAP approved",
    when: "A Lead approves someone's Setup Access Pass request (before their pass PDF is ready).",
    link: "the sign-in page, with their email filled in",
    required: ["link"],
    extra: ["day"],
  },
  {
    kind: "sap_ready",
    feature: "saps",
    name: "SAP ready to print",
    when: "Someone's approved Setup Access Pass has its PDF, ready to download.",
    link: "the sign-in page, with their email filled in",
    required: ["link"],
    extra: ["day"],
  },
];

export const isEditable = (kind: string): kind is MailKind => EDITABLE.some((t) => t.kind === kind);

// {product} appears only in the fixed (not editable) emails: the instance's name.
export function fill(
  text: string,
  data: { link: string; year: number; day?: string; camp: string; product?: string },
) {
  return text
    .replaceAll("{link}", data.link)
    .replaceAll("{year}", String(data.year))
    .replaceAll("{day}", data.day ?? "")
    .replaceAll("{camp}", data.camp)
    .replaceAll("{product}", data.product ?? "");
}

export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;

// Why an Admin's edit can't be saved, or null. Unknown placeholders (e.g. a typo like
// {yaer}) are refused so they'd never reach a camper as literal text.
export function templateProblem(kind: MailKind, t: TemplateText): string | null {
  const def = EDITABLE.find((e) => e.kind === kind);
  if (!def) return "That email can't be edited.";
  if (!t.subject.trim()) return "The subject can't be empty.";
  if (t.subject.length > SUBJECT_MAX) return `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (/[\r\n]/.test(t.subject)) return "The subject must be one line.";
  if (t.subject.includes("{link}")) return "Put {link} in the body, not the subject.";
  if (!t.body.trim()) return "The body can't be empty.";
  // Checked with the placeholders filled in, so "{camp}.org" can't turn into a real domain
  // once the camp's name is put in.
  const sample = fill(`${t.subject}\n${t.body}`, {
    link: " ",
    year: 2027,
    day: "Friday",
    camp: "Camp",
  });
  if (looksLikeLink(`${t.subject}\n${t.body}`) || looksLikeLink(sample)) {
    return "Leave out web and email addresses: the only link an email can carry is {link}.";
  }
  if (t.body.length > BODY_MAX) return `Keep the body under ${BODY_MAX} characters.`;
  for (const p of def.required) {
    if (!t.body.includes(`{${p}}`)) return `The body must include {${p}}: it's ${def.link}.`;
  }
  const allowed = ["link", "year", "camp", ...(def.extra ?? [])];
  const unknown = [...`${t.subject}\n${t.body}`.matchAll(/\{([^{}\s]*)\}/g)]
    .map((m) => m[1])
    .filter((name) => !allowed.includes(name));
  if (unknown.length) {
    return `Unknown placeholder {${unknown[0]}}. Use ${allowed.map((a) => `{${a}}`).join(", ")}.`;
  }
  return null;
}
