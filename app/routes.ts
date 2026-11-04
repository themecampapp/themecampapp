// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { index, layout, prefix, type RouteConfig, route } from "@react-router/dev/routes";

// Public routes are listed explicitly here AND in tests/authz/routes.test.ts.
// Everything else must be nested under the _app layout (enforced by that test).
export default [
  route("sign-in", "routes/sign-in.tsx"),
  route("demo/enter", "routes/demo.enter.tsx"),
  route("sign-in/check-email", "routes/sign-in.check-email.tsx"),
  route("sign-in/confirm", "routes/sign-in.confirm.tsx"),
  route("sign-in/error", "routes/sign-in.error.tsx"),
  route("sign-out", "routes/sign-out.ts"),
  route("api/auth/*", "routes/api.auth.$.ts"),
  // Confirms a sign-in email change from the link sent to the new address (token-only).
  route("email/confirm", "routes/email.confirm.tsx"),
  route("email/approve", "routes/email.approve.tsx"),
  route("join", "routes/join.tsx"),
  // Support access (R39): the console posts a single-use token here; leaving clears the cookie.
  route("support/enter", "routes/support.enter.ts"),
  route("support/leave", "routes/support.leave.ts"),
  // R45a: confirming a data request from the link emailed to the requester.
  route("confirm/request/:token", "routes/confirm.request.$token.tsx"),
  // The camp's logo: public, like the sign-in page it appears on.
  route("logo/:name", "routes/logo.$name.ts"),
  route("join/thanks", "routes/join.thanks.tsx"),
  // Public guides are open; members-only guides check membership in their own loader.
  route("guides", "routes/guides._index.tsx"),
  route("guides/:slug", "routes/guides.$slug.tsx"),
  // A single-camp instance's legal pages (open-source plan 3.4): it has no public site to
  // serve them. Elsewhere they're on the platform Worker's apex, and this answers 404.
  route("legal/:doc", "routes/legal.$doc.tsx"),

  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("rsvp", "routes/_app.rsvp.tsx"),
    route("profile", "routes/_app.profile.tsx"),
    route("tickets/request", "routes/_app.tickets.request.tsx"),
    route("yearbook", "routes/_app.yearbook.tsx"),
    route("volunteer", "routes/_app.volunteer.tsx"),
    route("yearbook/:year", "routes/_app.yearbook.$year.tsx"),
    route("photos/:key", "routes/_app.photos.$key.ts"),
    // A SAP's PDF: its holder or a Lead (checked in the route).
    route("saps/pass/:id/pdf", "routes/_app.saps.pass.$id.pdf.ts"),
    // Treasurer only; the page checks the role itself, since a Treasurer need not be a Lead.
    route("dues", "routes/_app.dues.tsx"),
    route("privacy-notice", "routes/_app.privacy-notice.tsx"),
    route("orientation", "routes/_app.orientation.tsx"),
    // R65: feedback about Theme Camp App, to its operator.
    route("feedback", "routes/_app.feedback.tsx"),
    route("setup-checklist", "routes/_app.setup-checklist.tsx"),

    // Admin-only pages: the _app.admin layout's middleware refuses everyone else.
    layout("routes/_app.admin.tsx", [
      ...prefix("admin", [
        index("routes/_app.admin._index.tsx"),
        route("emails", "routes/_app.admin.emails._index.tsx"),
        // Issue #56: page wording each camp can change.
        route("wording", "routes/_app.admin.wording.tsx"),
        route("saps", "routes/_app.admin.saps.tsx"),
        route("positions", "routes/_app.admin.positions.tsx"),
        route("logs", "routes/_app.admin.logs.tsx"),
        route("activity", "routes/_app.admin.activity.tsx"),
        route("settings", "routes/_app.admin.settings.tsx"),
        route("agreement", "routes/_app.admin.agreement.tsx"),
        route("guide", "routes/_app.admin.guide.tsx"),
        route("features", "routes/_app.admin.features.tsx"),
        // Issue #93: the camp's roles (Lead and Treasurer as presets, and custom roles).
        route("roles", "routes/_app.admin.roles._index.tsx"),
        route("roles/new", "routes/_app.admin.roles.new.tsx"),
        route("roles/:key", "routes/_app.admin.roles.$key.tsx"),
        route("support", "routes/_app.admin.support.tsx"),
        route("exports", "routes/_app.admin.exports._index.tsx"),
        route("exports/:id", "routes/_app.admin.exports.$id.ts"),
        route("emails/:kind", "routes/_app.admin.emails.$kind.tsx"),
        // Issue #31: who camped in a past season.
        route("seasons/:year", "routes/_app.admin.seasons.$year.tsx"),
      ]),
    ]),

    // Lead-only pages: the _app.lead layout's middleware refuses everyone else.
    layout("routes/_app.lead.tsx", [
      ...prefix("people", [
        index("routes/_app.lead.people._index.tsx"),
        route("new", "routes/_app.lead.people.new.tsx"),
        route("invite", "routes/_app.lead.people.invite.tsx"),
        route("export", "routes/_app.lead.people.export.ts"),
        route("import", "routes/_app.lead.people.import.tsx"),
        route("import/template", "routes/_app.lead.people.import.template.ts"),
        route(":id", "routes/_app.lead.people.$id.tsx"),
        route(":id/rsvp", "routes/_app.lead.people.$id.rsvp.tsx"),
      ]),
      // Acting on a Roster view: nudges to the people picked, and the view as a CSV (Unit 8).
      route("roster/nudge", "routes/_app.lead.roster.nudge.tsx"),
      route("roster/export", "routes/_app.lead.roster.export.ts"),
      // The season roster, with a person's details open beside it (Lead workspace, Unit 6).
      route("roster", "routes/_app.lead.roster.tsx", [
        route(":personId", "routes/_app.lead.roster.$personId.tsx"),
      ]),
      route("tickets", "routes/_app.lead.tickets._index.tsx"),
      route("saps", "routes/_app.lead.saps.tsx"),
      route("volunteers", "routes/_app.lead.volunteers.tsx"),
      ...prefix("inquiries", [
        index("routes/_app.lead.inquiries._index.tsx"),
        route(":id", "routes/_app.lead.inquiries.$id.tsx"),
      ]),
      route("queue", "routes/_app.lead.queue.tsx"),
      route("announcements", "routes/_app.lead.announcements.tsx"),
      route("dates", "routes/_app.lead.dates.tsx"),
      // The camp's guides, drafts included (the public pages are /guides and /guides/:slug).
      ...prefix("guide-editor", [
        index("routes/_app.lead.guides._index.tsx"),
        route(":id", "routes/_app.lead.guides.$id.tsx"),
      ]),
    ]),
  ]),
] satisfies RouteConfig;
