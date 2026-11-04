// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Issue #65: a short guided tour of the Lead tools for Leads and Admins, on the home page.
// Each step points at a link already on the page (data-tour="<anchor>"); a step whose link
// isn't there (a feature the camp has off, Dues for a Lead who isn't the Treasurer) is
// skipped. Admins get the Lead steps, then the setup steps, as one tour.

export type OrientationLevel = "lead" | "admin";

export type OrientationStep = {
  key: string;
  anchor?: string; // no anchor: a card in the middle of the screen
  title: string;
  body: string;
  admin?: boolean; // only in an Admin's tour
};

export const ORIENTATION_STEPS: OrientationStep[] = [
  {
    key: "welcome",
    title: "Welcome to the Lead tools",
    body: "A quick look at where things are, in about a minute. Pause to pick up where you left off next time, or Stop to end the tour. You can take it again from your home page.",
  },
  {
    key: "home",
    anchor: "home-view",
    title: "Your home page",
    body: "Overview is the camp's to-do list: missing RSVPs and ticket requests, SAPs to decide, new inquiries. My participation has your own RSVP, tickets and dues.",
  },
  {
    key: "roster",
    anchor: "roster",
    title: "Roster",
    body: "Who's coming this year, with RSVPs, arrival dates and dwellings. Filter it, nudge people who haven't RSVP'd, and export a spreadsheet.",
  },
  {
    key: "tickets",
    anchor: "tickets",
    title: "Stewards Sale tickets",
    body: "Collect everyone's ticket requests, lock them when it's time, and send Burning Man the list.",
  },
  {
    key: "saps",
    anchor: "saps",
    title: "Setup Access Passes",
    body: "Decide who arrives early to build camp, and on which day.",
  },
  {
    key: "dues",
    anchor: "dues",
    title: "Dues",
    body: "Set the year's amount, any tiers, and how to pay, then record who has paid. Only the Treasurer and Admins see this.",
  },
  {
    key: "people",
    anchor: "people",
    title: "People",
    body: "Everyone in the camp, past and present. Add or import people, send invites, and make someone a Lead or Treasurer from their page.",
  },
  {
    key: "inquiries",
    anchor: "inquiries",
    title: "Inquiries",
    body: "People who asked to join on the camp's public join form. Keep notes on your conversations and invite them when they're ready.",
  },
  {
    key: "queue",
    anchor: "queue",
    title: "Queue",
    body: "Things only a Lead can sort out, like a sign-in that didn't match anyone or an email change to approve. Try to keep it empty.",
  },
  {
    key: "announcements",
    anchor: "announcements",
    title: "Announcements",
    body: "Post news to everyone's home page, and email it when it matters.",
  },
  {
    key: "dates",
    anchor: "dates",
    title: "Key dates",
    body: "The season's deadlines. Dates like \"Ticket requests close\" email a reminder to anyone who hasn't done it yet.",
  },
  {
    key: "guides",
    anchor: "guides",
    title: "Guides",
    body: "How-tos for your camp, ready to edit. The Lead handbook covers the whole season in more detail.",
  },
  {
    key: "admin",
    anchor: "admin",
    title: "Admin: camp setup",
    body: "Settings (contact email, payment methods, ticket limit), which features the camp uses, and the wording on members' pages. Admin → Guide explains each part.",
    admin: true,
  },
  {
    key: "checklist",
    anchor: "checklist",
    title: "Setting up your camp",
    body: "This checklist ticks itself off as you go. Work through it before you invite members.",
    admin: true,
  },
  {
    key: "season",
    anchor: "admin",
    title: "Admin: seasons and support",
    body: "After the burn, roll the camp over to next year from Admin → Season. Admin is also where you see the camp's activity, and where you can let the app's support see the camp for a while.",
    admin: true,
  },
  {
    key: "done",
    anchor: "tour-link",
    title: "That's the tour",
    body: 'Take it again any time from here. Ideas or problems? Use "Send feedback" at the bottom of any page.',
  },
];

export const isOrientationStep = (key: string) => ORIENTATION_STEPS.some((s) => s.key === key);

// The steps for this level, in order. A finished Lead tour that becomes an Admin's picks up at
// the first Admin step.
export function orientationSteps(level: OrientationLevel) {
  return ORIENTATION_STEPS.filter((s) => level === "admin" || !s.admin);
}

// Where the tour starts on its own, or null when it shouldn't: done at this level already.
export function orientationStart(
  level: OrientationLevel,
  done: OrientationLevel | null,
  pausedAt: string | null,
): string | null {
  if (done === "admin" || done === level) return null;
  if (pausedAt && orientationSteps(level).some((s) => s.key === pausedAt)) return pausedAt;
  if (done === "lead") return ORIENTATION_STEPS.find((s) => s.admin)?.key ?? null;
  return ORIENTATION_STEPS[0].key;
}
