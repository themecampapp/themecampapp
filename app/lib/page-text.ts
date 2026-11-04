// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureKey } from "./features";

// Page wording a camp's Admins can change (issue #56): instructions and camp policy shown on
// members' pages, never status messages, errors or what the app says about privacy (those
// must stay accurate). Each camp's version is stored over the default (app_setting
// `page_text:<key>`); resetting deletes it. Plain text: paragraphs, full https:// links (shown
// as typed, like announcements) and the placeholders {camp} and {year}.

export type PageTextKey =
  | "join_intro"
  | "join_note_hint"
  | "rsvp_intro"
  | "rsvp_sap_hint"
  | "tickets_intro"
  | "tickets_count_hint"
  | "tickets_locked"
  | "dues_timing"
  | "volunteer_instructions"
  | "yearbook_card"
  | "yearbook_intro"
  | "profile_photo"
  | "profile_email_hint";

export type PageText = {
  key: PageTextKey;
  page: string; // the page it's on, for grouping in the editor
  name: string;
  where: string; // exactly where it shows
  default: string;
  max: number;
  // An optional text may be saved empty, which hides it.
  optional?: boolean;
  feature?: FeatureKey; // listed and shown only while the camp has this feature on
};

export const PAGE_TEXTS: PageText[] = [
  {
    key: "join_intro",
    page: "Join form",
    name: "Introduction",
    where: "At the top of the public join form.",
    default:
      "We're a theme camp at Burning Man. Tell us a little about yourself and a camp lead will reach out to say hello.",
    max: 1000,
    feature: "join",
  },
  {
    key: "join_note_hint",
    page: "Join form",
    name: "Note field hint",
    where: 'Under "Anything you\'d like us to know?" on the public join form.',
    default: "Burn experience, what draws you to the camp, questions.",
    max: 300,
    optional: true,
    feature: "join",
  },
  {
    key: "rsvp_intro",
    page: "RSVP",
    name: "Introduction",
    where: "At the top of the RSVP page, for example a deadline. Empty by default.",
    default: "",
    max: 600,
    optional: true,
  },
  {
    key: "rsvp_sap_hint",
    page: "RSVP",
    name: "Setup Access Pass hint",
    where: 'Under "Request a Setup Access Pass (SAP)?" on the RSVP form.',
    default: "For arriving early to help build camp. Leads approve SAPs; see the SAP guide.",
    max: 300,
    feature: "saps",
  },
  {
    key: "tickets_intro",
    page: "Tickets",
    name: "Introduction",
    where: "At the top of the ticket request page, before the link to the tickets guide.",
    default:
      "{camp} gets Stewards Sale access. Tell us how many tickets you'll buy through the camp. Burning Man then emails you, at your Burner profile email, with instructions to buy them.",
    max: 600,
  },
  {
    key: "tickets_count_hint",
    page: "Tickets",
    name: "Number of tickets hint",
    where: 'Under "How many tickets do you need through the camp?"',
    default: "Include one for a partner or camp-mate you're buying for.",
    max: 300,
    optional: true,
  },
  {
    key: "tickets_locked",
    page: "Tickets",
    name: "Requests locked",
    where: "On the ticket request page once Leads lock requests, before what the member asked for.",
    default: "Requests are locked while Leads finalize the sale.",
    max: 300,
  },
  {
    key: "dues_timing",
    page: "Dues",
    name: "Payment timing",
    where: "On a member's home page while their dues aren't recorded as paid.",
    default: "The Treasurer marks payments by hand, so it can take a few days to show here.",
    max: 300,
    optional: true,
    feature: "dues",
  },
  {
    key: "volunteer_instructions",
    page: "Jobs",
    name: "Volunteer instructions",
    where: "At the top of the jobs page, and on members' home page until they have a job.",
    default: "Camp runs on volunteers. Everyone signs up for at least one job.",
    max: 400,
    feature: "volunteer",
  },
  {
    key: "yearbook_card",
    page: "Yearbook",
    name: "Home page card",
    where: "In the Yearbook card on members' home page.",
    default: "See who's coming this year, and add your photo so campers can learn your name.",
    max: 300,
    feature: "yearbook",
  },
  {
    key: "yearbook_intro",
    page: "Yearbook",
    name: "Introduction",
    where:
      "At the top of the Yearbook, before the app's note on who's in it (Going or Leaning yes, with a photo; members only).",
    default: "The faces of camp.",
    max: 300,
    feature: "yearbook",
  },
  {
    key: "profile_photo",
    page: "Yearbook",
    name: "Photo guidance",
    where:
      "Above the photo upload on each member's profile, before the app's note on who can see the photo.",
    default:
      "A head-and-shoulders photo of just you, square or landscape, helps campers learn names.",
    max: 400,
    feature: "yearbook",
  },
  {
    key: "profile_email_hint",
    page: "Profile",
    name: "Sign-in email note",
    where: "On each member's profile, with their sign-in email. Empty it to hide it.",
    default:
      "Please use the same email address as your Burner Profile. That's where Burning Man sends Stewards Sale ticket emails, and it helps {camp} match your ticket request.",
    max: 300,
    optional: true,
  },
];

export const pageTextKey = (key: PageTextKey) => `page_text:${key}`;
export const isPageTextKey = (key: string): key is PageTextKey =>
  PAGE_TEXTS.some((t) => t.key === key);
export const pageTextDef = (key: PageTextKey) => PAGE_TEXTS.find((t) => t.key === key) as PageText;

const PLACEHOLDER_RE = /\{([a-z]+)\}/g;

// Why a camp's version can't be saved, or null.
export function pageTextProblem(key: PageTextKey, text: string): string | null {
  const def = pageTextDef(key);
  if (!text.trim() && !def.optional)
    return "This text can't be empty. Reset it to use the default.";
  if (text.length > def.max) return `Keep it under ${def.max} characters.`;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m[1] !== "camp" && m[1] !== "year") {
      return `{${m[1]}} isn't something the app can fill in. Use {camp} or {year}.`;
    }
  }
  if (/<[a-z/!]/i.test(text)) return "Plain text only: no HTML.";
  if (/\bhttp:\/\//i.test(text)) return "Links must start with https://.";
  return null;
}

export const fillPageText = (text: string, v: { camp: string; year: number }) =>
  text.replaceAll("{camp}", v.camp).replaceAll("{year}", String(v.year));
