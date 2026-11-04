// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ZULU_APPROVE_TOKEN,
  ZULU_EMAIL_TOKEN,
  ZULU_ONLY_YEAR,
  type Zulu,
} from "../helpers/two-camps";

// Every route in app/routes.ts, and how to aim it at camp B's records while signed in to camp A
// as an Admin (who is also a Lead and Treasurer, so every page is open to them).
// tests/authz/cross-camp.test.ts runs each probe and requires:
//   - no camp B marker (name, email, id) anywhere in the response;
//   - no server error, and `status` exactly when given (404 for a camp B record in the URL);
//   - for writes, camp B's data unchanged, row for row.
// A route missing from here fails the suite: adding a route means adding its probes.

export type Probe = {
  name: string;
  method?: "GET" | "POST";
  path: (z: Zulu) => string;
  form?: (z: Zulu) => Record<string, string | string[]>;
  status?: number;
  // Sent without camp A's session (public pages, and sign-out, which would end it).
  anonymous?: boolean;
};

export type Entry = Probe[] | "layout";

const get = (name: string, path: (z: Zulu) => string, extra: Partial<Probe> = {}): Probe => ({
  name,
  path,
  ...extra,
});
const post = (
  name: string,
  path: (z: Zulu) => string,
  form: (z: Zulu) => Record<string, string | string[]>,
  extra: Partial<Probe> = {},
): Probe => ({ name, method: "POST", path, form, ...extra });

export const REGISTRY: Record<string, Entry> = {
  // Public and sign-in pages.
  "routes/sign-in.tsx": [get("sign-in page", () => "/sign-in", { anonymous: true })],
  "routes/sign-in.check-email.tsx": [
    get("check-email page", () => "/sign-in/check-email", { anonymous: true }),
  ],
  "routes/sign-in.confirm.tsx": [
    // The page echoes the token it's given, so this one carries no camp B marker.
    get("confirm page", () => "/sign-in/confirm?token=x", { anonymous: true }),
    post(
      "confirm B's token",
      () => "/sign-in/confirm",
      (z) => ({ token: `${z.campId}.x` }),
      {
        anonymous: true,
        status: 302,
      },
    ),
  ],
  "routes/sign-in.error.tsx": [get("sign-in error", () => "/sign-in/error", { anonymous: true })],
  "routes/sign-out.ts": [
    post(
      "sign out",
      () => "/sign-out",
      () => ({}),
      { anonymous: true },
    ),
  ],
  "routes/api.auth.$.ts": [get("get-session", () => "/api/auth/get-session")],
  "routes/email.confirm.tsx": [
    get("email confirm page", () => `/email/confirm?token=${ZULU_EMAIL_TOKEN}`),
    post(
      "confirm B's email change",
      () => "/email/confirm",
      () => ({ token: ZULU_EMAIL_TOKEN }),
    ),
  ],
  "routes/email.approve.tsx": [
    get("email approve page", () => `/email/approve?token=${ZULU_APPROVE_TOKEN}`),
    post(
      "approve B's email change",
      () => "/email/approve",
      () => ({ token: ZULU_APPROVE_TOKEN }),
    ),
  ],
  "routes/join.tsx": [get("join page", () => "/join", { anonymous: true })],
  "routes/join.thanks.tsx": [get("join thanks", () => "/join/thanks", { anonymous: true })],
  "routes/guides._index.tsx": [get("guides", () => "/guides")],
  "routes/guides.$slug.tsx": [
    get("a guide", () => "/guides/welcome"),
    get("B's public guide", (z) => `/guides/${z.guideSlug}`, { status: 404 }),
  ],

  // Member pages.
  "routes/_app.tsx": "layout",
  "routes/_app._index.tsx": [get("home", () => "/")],
  "routes/_app.rsvp.tsx": [
    get("rsvp", () => "/rsvp"),
    post(
      "save own rsvp",
      () => "/rsvp",
      () => ({ intent: "going" }),
    ),
  ],
  "routes/_app.profile.tsx": [get("profile", () => "/profile")],
  "routes/_app.tickets.request.tsx": [get("ticket request", () => "/tickets/request")],
  "routes/_app.yearbook.tsx": [
    get("yearbook", () => "/yearbook"),
    get("directory", () => "/yearbook?view=directory"),
  ],
  "routes/_app.yearbook.$year.tsx": [
    get("B-only season's yearbook", () => `/yearbook/${ZULU_ONLY_YEAR}`, { status: 404 }),
  ],
  "routes/_app.volunteer.tsx": [
    get("volunteer", () => "/volunteer"),
    post(
      "sign up for B's role",
      () => "/volunteer",
      (z) => ({ roleId: z.roleId }),
    ),
    post(
      "leave B's role",
      () => "/volunteer",
      (z) => ({ intent: "leave", roleId: z.roleId }),
    ),
  ],
  "routes/_app.photos.$key.ts": [
    get("B's photo", (z) => `/photos/${z.photoKey.slice(z.photoKey.lastIndexOf("/") + 1)}`, {
      status: 404,
    }),
  ],
  "routes/support.enter.ts": [
    post(
      "a made-up support token",
      () => "/support/enter",
      () => ({ token: "x".repeat(43) }),
      {
        anonymous: true,
        status: 403,
      },
    ),
  ],
  "routes/support.leave.ts": [
    post(
      "leave support",
      () => "/support/leave",
      () => ({}),
      { anonymous: true, status: 302 },
    ),
  ],
  "routes/confirm.request.$token.tsx": [
    get("B's request link at A", (z) => `/confirm/request/${z.requestToken}`, { anonymous: true }),
    post(
      "confirm B's request at A",
      (z) => `/confirm/request/${z.requestToken}`,
      () => ({}),
      {
        anonymous: true,
      },
    ),
  ],
  "routes/_app.admin.exports._index.tsx": [get("exports", () => "/admin/exports")],
  "routes/_app.admin.exports.$id.ts": [
    get("B's export", (z) => `/admin/exports/${z.exportId}`, { status: 404 }),
  ],
  "routes/_app.privacy-notice.tsx": [
    post(
      "acknowledge the notice",
      () => "/privacy-notice",
      () => ({}),
    ),
  ],
  // Only ever changes the signed-in person's own orientation progress.
  "routes/_app.orientation.tsx": [
    post(
      "pause the orientation",
      () => "/orientation",
      () => ({ intent: "pause", step: "people" }),
    ),
    post(
      "stop the orientation",
      () => "/orientation",
      () => ({ intent: "stop" }),
    ),
  ],
  "routes/_app.feedback.tsx": [
    get("feedback page from B's person", (z) => `/feedback?from=/people/${z.memberId}`),
    post(
      "feedback naming B's person",
      () => "/feedback",
      (z) => ({ from: `/people/${z.memberId}?x=${z.leadId}`, message: "Hello" }),
      { status: 302 },
    ),
  ],
  "routes/demo.enter.tsx": [
    get("the demo's way in, at a real camp", () => "/demo/enter", { status: 404 }),
  ],
  "routes/_app.setup-checklist.tsx": [
    post(
      "hide the setup checklist",
      () => "/setup-checklist",
      () => ({ intent: "dismiss" }),
      { status: 302 },
    ),
    // Issue #82: only ever the signed-in camp's own setting.
    post(
      "note the Discord link was opened",
      () => "/setup-checklist",
      () => ({ intent: "community" }),
    ),
  ],
  "routes/_app.admin.guide.tsx": [get("the Admin guide", () => "/admin/guide")],
  "routes/_app.admin.agreement.tsx": [
    get("the pilot agreement", () => "/admin/agreement"),
    post(
      "accept the pilot agreement",
      () => "/admin/agreement",
      () => ({ agree: "on" }),
      { status: 302 },
    ),
  ],
  "routes/_app.admin.support.tsx": [
    get("support access", () => "/admin/support"),
    post(
      "revoke support",
      () => "/admin/support",
      () => ({ intent: "revoke" }),
    ),
  ],
  "routes/logo.$name.ts": [get("B's logo", (z) => `/logo/${z.logoName}`, { status: 404 })],
  // No camp data: the instance's legal pages, and only on a single-camp instance (3.4).
  "routes/legal.$doc.tsx": [get("the legal pages", () => "/legal/terms", { status: 404 })],
  "routes/_app.saps.pass.$id.pdf.ts": [
    get("B's SAP pdf", (z) => `/saps/pass/${z.passId}/pdf`, { status: 404 }),
  ],
  "routes/_app.dues.tsx": [
    get("dues", () => "/dues"),
    post(
      "record dues for B's person",
      () => "/dues",
      (z) => ({
        personId: z.memberId,
        status: "paid",
        amount: "100",
      }),
    ),
  ],

  // Admin pages.
  "routes/_app.admin.tsx": "layout",
  "routes/_app.admin._index.tsx": [
    get("admin", () => "/admin"),
    post(
      "switch to B's season",
      () => "/admin",
      () => ({
        intent: "switch",
        year: String(ZULU_ONLY_YEAR),
      }),
    ),
  ],
  "routes/_app.admin.emails._index.tsx": [get("email list", () => "/admin/emails")],
  "routes/_app.admin.emails.$kind.tsx": [get("invite email", () => "/admin/emails/invite")],
  "routes/_app.admin.seasons.$year.tsx": [
    get("a past season", () => "/admin/seasons/2026"),
    post(
      "tick B's person as having camped",
      () => "/admin/seasons/2026",
      (z) => ({ camped: [z.memberId, z.leadId] }),
      { status: 302 },
    ),
  ],
  "routes/_app.admin.wording.tsx": [
    get("page wording", () => "/admin/wording"),
    post(
      "save page wording (only ever camp A's)",
      () => "/admin/wording",
      () => ({ key: "volunteer_instructions", text: "Camp A's wording" }),
      { status: 302 },
    ),
  ],
  "routes/_app.admin.saps.tsx": [
    get("admin saps", () => "/admin/saps"),
    post(
      "delete B's pass",
      () => "/admin/saps",
      (z) => ({ intent: "delete", passId: z.passId }),
    ),
    post(
      "remove B's pass pdf",
      () => "/admin/saps",
      (z) => ({
        intent: "remove_pdf",
        passId: z.passId,
      }),
    ),
  ],
  // Issue #106: positions are jobs; the old page only redirects to the jobs page.
  "routes/_app.admin.positions.tsx": [
    get("positions (redirect)", () => "/admin/positions", { status: 302 }),
  ],
  "routes/_app.admin.logs.tsx": [get("sign-in log", () => "/admin/logs")],
  "routes/_app.admin.activity.tsx": [get("activity", () => "/admin/activity")],
  // Camp A's own settings, saved unchanged: camp B's settings row must stay as it was.
  "routes/_app.admin.settings.tsx": [
    get("camp settings", () => "/admin/settings"),
    post(
      "save settings",
      () => "/admin/settings",
      () => ({
        name: "Test Camp",
        accent: "",
        contactEmail: "",
        joinIntro: "",
        inquiryNotify: "leads@example.com",
        maxTickets: "2",
        paymentMethods: "venmo\nzelle\ncash\nother",
      }),
      { status: 302 },
    ),
  ],
  // Issue #93: the camp's roles. Camp B's custom role is a 404, and can't be changed or given.
  "routes/_app.admin.roles._index.tsx": [get("roles", () => "/admin/roles")],
  "routes/_app.admin.roles.new.tsx": [
    get("new role", () => "/admin/roles/new"),
    post(
      "create a role",
      () => "/admin/roles/new",
      () => ({ name: "Alpha helper" }),
      {
        status: 302,
      },
    ),
  ],
  "routes/_app.admin.roles.$key.tsx": [
    get("B's role", (z) => `/admin/roles/${z.customRoleId}`, { status: 404 }),
    get("own Lead (B's customized Lead stays B's)", () => "/admin/roles/lead"),
    post(
      "save B's role",
      (z) => `/admin/roles/${z.customRoleId}`,
      () => ({ intent: "save", name: "Taken" }),
      {
        status: 404,
      },
    ),
    post(
      "archive B's role",
      (z) => `/admin/roles/${z.customRoleId}`,
      () => ({ intent: "archive" }),
      {
        status: 404,
      },
    ),
  ],
  "routes/_app.admin.features.tsx": [
    get("features", () => "/admin/features"),
    post(
      "save features",
      () => "/admin/features",
      () => ({ on: ["dues", "join", "yearbook", "saps", "volunteer"] }),
      { status: 302 },
    ),
  ],

  // Lead pages.
  "routes/_app.lead.tsx": "layout",
  "routes/_app.lead.people._index.tsx": [
    get("people", () => "/people"),
    get("people search", () => "/people?q=zzb"),
  ],
  "routes/_app.lead.people.new.tsx": [
    post(
      "add a person",
      () => "/people/new",
      () => ({ legalName: "New Alpha Person" }),
    ),
  ],
  "routes/_app.lead.people.invite.tsx": [
    get("bulk invite", () => "/people/invite"),
    post(
      "invite B's person",
      () => "/people/invite",
      (z) => ({ personId: z.memberId }),
    ),
  ],
  "routes/_app.lead.people.export.ts": [get("people export", () => "/people/export")],
  "routes/_app.lead.people.import.tsx": [
    get("import page", () => "/people/import"),
    get("B's import preview", (z) => `/people/import?batch=${z.importBatchId}`, { status: 404 }),
    post(
      "apply B's import",
      () => "/people/import",
      (z) => ({ intent: "apply", batch: z.importBatchId }),
    ),
    post(
      "cancel B's import",
      () => "/people/import",
      (z) => ({ intent: "cancel", batch: z.importBatchId }),
      { status: 302 },
    ),
  ],
  "routes/_app.lead.people.import.template.ts": [
    get("import template", () => "/people/import/template"),
  ],
  "routes/_app.lead.people.$id.tsx": [
    get("B's person page", (z) => `/people/${z.memberId}`, { status: 404 }),
    ...["deactivate", "unlink", "invite", "remove_photo", "nudge"].map((intent) =>
      post(
        `${intent} B's person`,
        (z) => `/people/${z.leadId}`,
        () => ({ intent }),
        { status: 404 },
      ),
    ),
    post(
      "grant a role to B's person",
      (z) => `/people/${z.memberId}`,
      () => ({ intent: "grant", role: "admin" }),
      { status: 404 },
    ),
    post(
      "give own person B's custom role",
      (z) => `/people/${z.alpha.personId}`,
      (z) => ({ intent: "grant", role: `custom:${z.customRoleId}` }),
    ),
    post(
      "revoke B's Lead's role",
      (z) => `/people/${z.leadId}`,
      () => ({ intent: "revoke", role: "lead" }),
      { status: 404 },
    ),
    post(
      "reactivate B's person",
      (z) => `/people/${z.memberId}`,
      () => ({ intent: "reactivate" }),
      {
        status: 404,
      },
    ),
    post(
      "set B's person's camp years",
      (z) => `/people/${z.memberId}`,
      () => ({ intent: "camp_years", year_2024: "yes", year_2025: "yes", year_2026: "no" }),
      { status: 404 },
    ),
    post(
      "edit B's person",
      (z) => `/people/${z.memberId}`,
      () => ({ intent: "update", legalName: "Hijacked", email: "hijack@example.com" }),
      { status: 404 },
    ),
  ],
  "routes/_app.lead.people.$id.rsvp.tsx": [
    get("B's person's rsvp", (z) => `/people/${z.memberId}/rsvp`, { status: 404 }),
    post(
      "rsvp for B's person",
      (z) => `/people/${z.memberId}/rsvp`,
      () => ({ intent: "going" }),
    ),
  ],
  "routes/_app.lead.roster.nudge.tsx": [
    post(
      "preview nudges to B's people",
      () => "/roster/nudge",
      (z) => ({ search: "?preset=no-rsvp", id: z.memberId }),
    ),
    post(
      "send nudges to B's people",
      () => "/roster/nudge",
      (z) => ({ intent: "send", search: "?preset=no-rsvp", id: z.memberId }),
      { status: 302 },
    ),
  ],
  "routes/_app.lead.roster.export.ts": [
    get("a roster view as CSV", () => "/roster/export?preset=everyone"),
  ],
  "routes/_app.lead.roster.$personId.tsx": [
    get("B's person beside the roster", (z) => `/roster/${z.memberId}`, { status: 404 }),
  ],
  "routes/_app.lead.roster.tsx": [
    get("roster", () => "/roster"),
    ...[
      "everyone",
      "coming",
      "no-rsvp",
      "missing-ticket",
      "arrivals",
      "pending-sap",
      "sap",
      "generators",
      "no-volunteer",
      "unpaid",
    ].map((preset) => get(`roster preset ${preset}`, () => `/roster?preset=${preset}`)),
    get("an old roster view's new address", () => "/roster?view=missing", { status: 302 }),
  ],
  "routes/_app.lead.tickets._index.tsx": [
    get("tickets", () => "/tickets"),
    post(
      "record B's person's request",
      () => "/tickets",
      (z) => ({
        intent: "record_request",
        personId: z.memberId,
        ticketsNeeded: "1",
      }),
    ),
  ],
  "routes/_app.lead.saps.tsx": [
    get("saps", () => "/saps"),
    ...["approve", "deny", "release", "undo"].map((intent) =>
      post(
        `${intent} B's SAP`,
        () => "/saps",
        (z) => ({
          intent,
          participationId: z.participationId,
          passId: z.passId,
        }),
      ),
    ),
  ],
  "routes/_app.lead.volunteers.tsx": [
    get("volunteers", () => "/volunteers"),
    ...["add_person", "remove_person"].map((intent) =>
      post(
        `${intent} on B's role`,
        () => "/volunteers",
        (z) => ({
          intent,
          roleId: z.roleId,
          personId: z.memberId,
        }),
      ),
    ),
    ...["retire", "update"].map((intent) =>
      post(
        `${intent} B's role`,
        () => "/volunteers",
        (z) => ({
          intent,
          roleId: z.roleId,
          title: "Taken over",
          slots: "5",
        }),
      ),
    ),
    post(
      "make B's person a Lead",
      () => "/volunteers",
      (z) => ({
        intent: "make_lead",
        personId: z.memberId,
      }),
    ),
  ],
  "routes/_app.lead.inquiries._index.tsx": [get("inquiries", () => "/inquiries")],
  "routes/_app.lead.inquiries.$id.tsx": [
    get("B's inquiry", (z) => `/inquiries/${z.inquiryId}`, { status: 404 }),
    ...["note", "status", "assign", "invite", "close_existing"].map((intent) =>
      post(
        `${intent} on B's inquiry`,
        (z) => `/inquiries/${z.inquiryId}`,
        (z) => ({
          intent,
          body: "hi",
          status: "declined",
          assignedTo: z.leadId,
          personId: z.memberId,
        }),
        { status: 404 },
      ),
    ),
  ],
  // (Mixed references, where camp A's own record is given a camp B id, are in MIXED below.)
  "routes/_app.lead.guides._index.tsx": [
    get("guide editor", () => "/guide-editor"),
    post(
      "move B's guide",
      () => "/guide-editor",
      (z) => ({ intent: "up", id: z.guideId }),
    ),
    post(
      "publish B's draft",
      () => "/guide-editor",
      (z) => ({
        intent: "publish",
        id: z.guideDraftId,
      }),
    ),
    post(
      "copy a starter guide (into A only)",
      () => "/guide-editor",
      () => ({ intent: "copy_starter", slug: "lead-handbook" }),
      { status: 302 },
    ),
  ],
  "routes/_app.lead.guides.$id.tsx": [
    get("B's guide in the editor", (z) => `/guide-editor/${z.guideId}`, { status: 404 }),
    post(
      "save B's guide",
      (z) => `/guide-editor/${z.guideId}`,
      () => ({ intent: "save", title: "Hijacked", summary: "", body: "x", visibility: "public" }),
      { status: 404 },
    ),
    post(
      "preview B's guide",
      (z) => `/guide-editor/${z.guideId}`,
      () => ({ intent: "preview", title: "x", summary: "", body: "x", visibility: "public" }),
      { status: 404 },
    ),
    post(
      "delete B's draft",
      (z) => `/guide-editor/${z.guideDraftId}`,
      () => ({ intent: "delete" }),
      {
        status: 404,
      },
    ),
  ],
  "routes/_app.lead.announcements.tsx": [
    get("announcements", () => "/announcements"),
    post(
      "edit B's announcement",
      () => "/announcements",
      (z) => ({
        intent: "edit",
        id: z.announcementId,
        title: "Hijacked",
        body: "",
        showUntil: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
      }),
    ),
    post(
      "remove B's announcement",
      () => "/announcements",
      (z) => ({
        intent: "remove",
        id: z.announcementId,
      }),
    ),
    post(
      "email B's announcement",
      () => "/announcements",
      (z) => ({
        intent: "send_email",
        id: z.announcementId,
      }),
    ),
    get("preview emailing B's announcement", (z) => `/announcements?email=${z.announcementId}`),
  ],
  "routes/_app.lead.dates.tsx": [
    get("key dates", () => "/dates"),
    post(
      "edit B's date",
      () => "/dates",
      (z) => ({
        intent: "edit",
        id: z.keyDateId,
        label: "Hijacked",
        date: "2099-02-02",
        action: "",
      }),
    ),
    post(
      "remove B's date",
      () => "/dates",
      (z) => ({ intent: "remove", id: z.keyDateId }),
    ),
  ],
  "routes/_app.lead.queue.tsx": [
    get("queue", () => "/queue"),
    post(
      "resolve B's queue item",
      () => "/queue",
      (z) => ({ id: z.queueItemId }),
    ),
  ],
};

// Routes with no registry entry, and entries for routes that no longer exist.
export function registryGaps(routeFiles: string[], registry: Record<string, Entry> = REGISTRY) {
  const listed = new Set(Object.keys(registry));
  const routes = new Set(routeFiles);
  return {
    missing: routeFiles.filter((f) => !listed.has(f)),
    extra: [...listed].filter((f) => !routes.has(f)),
  };
}

// Camp A's own records pointed at camp B ids. They run with the same checks (no markers, no
// 5xx, camp B unchanged); the composite foreign keys also keep camp A's rows from ever
// referencing camp B's.
export const MIXED: Probe[] = [
  post(
    "add B's person to A's job",
    () => "/volunteers",
    (z) => ({
      intent: "add_person",
      roleId: z.alpha.roleId,
      personId: z.memberId,
    }),
  ),
  post(
    "close A's inquiry as B's person",
    (z) => `/inquiries/${z.alpha.inquiryId}`,
    (z) => ({
      intent: "close_existing",
      personId: z.memberId,
    }),
  ),
  post(
    "give A's camper B's SAP pass",
    () => "/saps",
    (z) => ({
      intent: "approve",
      participationId: z.alpha.participationId,
      passId: z.passId,
    }),
  ),
];
