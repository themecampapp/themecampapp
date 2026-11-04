// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { count, eq } from "drizzle-orm";
import {
  data,
  Form,
  Link,
  NavLink,
  Outlet,
  redirect,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import { accessErrorPage } from "~/components/AccessError";
import { CampMark, CampName } from "~/components/CampName";
import { LegalLinks } from "~/components/LegalLinks";
import { MobileMenu, type NavGroup } from "~/components/MobileMenu";
import { Orientation } from "~/components/Orientation";
import { btn } from "~/components/ui";
import { WhoSeesWhat } from "~/components/WhoSeesWhat";
import { inquiry, leadQueueItem, person } from "~/db/schema";
import { assertRouteAccess, can, getViewer, inWorkspace, requireMember } from "~/lib/access.server";
import { useCamp } from "~/lib/camp";
import { cloudflareContext, defer, getDb, getSettings, getWriteDb } from "~/lib/context.server";
import { whoSees } from "~/lib/data/camp-roles.server";
import { guideSlugs } from "~/lib/data/guides.server";
import { DEMO_ROLE, DEMO_ROLES } from "~/lib/demo";
import { BM_DISCLAIMER } from "~/lib/disclaimer";
import { featureForPath } from "~/lib/features";
import { featureOn } from "~/lib/instance-features";
import { pilotAgreementOn } from "~/lib/legal";
import { orientationStart } from "~/lib/orientation";
import { type AreaKey, atLeast, type Level, routePath } from "~/lib/permissions";
import { activeGrant, logSupportView } from "~/lib/support.server";
import { campReadOnly } from "~/lib/tenancy.server";
import type { loader as homeLoader } from "./_app._index";
import type { Route } from "./+types/_app";

const AGREEMENT_OPEN = new Set(["/admin/agreement", "/privacy-notice"]);

// Every private page lives under this layout. The middleware runs before any of their
// loaders or actions: signed-out visitors are sent to sign-in, and signed-in people without
// an active membership get the not-a-member page with no data.
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context, pattern }) => {
    const viewer = await requireMember(request, context);
    const path = new URL(request.url).pathname;
    // R74: counted as active today (the Worker writes it after the response).
    if (!viewer.support && !viewer.demo) context.get(cloudflareContext).personId = viewer.personId;
    // R40: every page Theme Camp App support views goes into the camp's Activity. (Photos are
    // parts of pages, not pages.) Written after the response, even for a suspended camp.
    if (viewer.support && !path.startsWith("/photos/")) {
      defer(context, logSupportView(getWriteDb(context), viewer.support, path));
    }
    // R68: in a camp created in the console, Admins use nothing else until one of them has
    // accepted the pilot agreement, where the instance has one (open-source plan 3.6).
    // (Client-side navigations ask for "<path>.data".)
    if (viewer.isAdmin && !viewer.support && pilotAgreementOn(context.get(cloudflareContext).env)) {
      const { setup } = await getSettings(context);
      const route = path.replace(/\.data$/, "");
      if (setup.createdInConsole && !setup.agreementAccepted && !AGREEMENT_OPEN.has(route)) {
        throw redirect("/admin/agreement");
      }
    }
    // A switched-off feature's pages don't exist (R20); its data stays. By the matched route,
    // so a ".data" request or a path in other letter case finds the same feature.
    const route = routePath(pattern);
    const feature = featureForPath(route);
    if (feature && !(await getSettings(context)).features[feature]) {
      throw data({ reason: "not_found" }, { status: 404 });
    }
    // Issue #93: the Lead tools' pages need their area's level (reading) or manage (changes).
    assertRouteAccess(viewer, route, request.method);
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const v = getViewer(context);
  let openQueue = 0;
  let newInquiries = 0;
  if (can(v, "inquiries")) {
    const [inq] = await getDb(context)
      .select({ n: count() })
      .from(inquiry)
      .where(eq(inquiry.status, "new"));
    newInquiries = inq?.n ?? 0;
  }
  if (can(v, "people", "manage")) {
    const [row] = await getDb(context)
      .select({ n: count() })
      .from(leadQueueItem)
      .where(eq(leadQueueItem.status, "open"));
    openQueue = row?.n ?? 0;
  }
  const { features } = await getSettings(context);
  // Admins see when support can see the camp (R39); support sees that it's in support view.
  const grant = v.isAdmin && !v.support ? await activeGrant(getDb(context)) : null;
  // R51: on their first sign-in here, a member sees who can see what, until they say "Got it".
  // Not while the camp can't take the write that records it (suspended, or the demo).
  const [me] =
    v.support || campReadOnly(context.get(cloudflareContext).camp, false)
      ? []
      : await getDb(context)
          .select({
            seen: person.privacyNoticeSeenAt,
            orientationDone: person.orientationDone,
            orientationStep: person.orientationStep,
          })
          .from(person)
          .where(eq(person.id, v.personId));
  // Issue #65: the Lead orientation. Saved on the person; the demo (which saves nothing) keeps
  // it in the browser. Not in support view, or while the camp can't save it (suspended).
  const level = v.isAdmin ? ("admin" as const) : ("lead" as const);
  const orientation =
    !inWorkspace(v) || v.support
      ? null
      : v.demo
        ? { level, local: true }
        : me
          ? {
              level,
              local: false,
              start: orientationStart(level, me.orientationDone, me.orientationStep),
            }
          : null;
  return {
    features,
    // R65 feedback to the operator: only where the instance takes it (3.7).
    feedbackOn: featureOn(context.get(cloudflareContext).env, "feedback"),
    orientation,
    supportView: v.support ? { until: v.support.expiresAt } : null,
    demo: v.demo ?? null,
    supportGrantUntil: grant ? grant.expiresAt.toISOString() : null,
    // R51: until they say "Got it". Issue #93: who sees what, from the camp's roles.
    privacyNotice:
      me !== undefined && me.seen === null
        ? await (async () => {
            const who = await whoSees(getDb(context), features);
            return { seesPrivate: who.private, seesDues: who.dues };
          })()
        : null,
    // Guides this member can open, so pages link only to guides the camp has (GuideLink).
    guideSlugs: await guideSlugs(getDb(context), { member: true, lead: inWorkspace(v) }),
    suspended: context.get(cloudflareContext).camp.status === "suspended",
    name: v.playaName ?? v.legalName,
    // Issue #93: the viewer's level in each area, for the navigation (the server checks again).
    access: v.access,
    isAdmin: v.isAdmin === true,
    openQueue,
    newInquiries,
  };
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? "font-semibold underline underline-offset-4" : "text-charcoal hover:text-night";

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { features } = loaderData;
  const { campName, productName } = useCamp();
  const { pathname } = useLocation();
  // The home page's first-sign-in question about sharing contact details comes before the tour.
  const askDirectory = useRouteLoaderData<typeof homeLoader>("routes/_app._index")?.askDirectory;
  // The Lead tools the viewer can open (issue #93: by area), in the header and the phone menu.
  const may = (area: AreaKey, level: Level = "view") => atLeast(loaderData.access[area], level);
  const leadLinks = [
    may("roster") && { to: "/roster", label: "Roster", tour: "roster" },
    may("tickets") && { to: "/tickets", label: "Tickets", tour: "tickets" },
    may("saps") && features.saps && { to: "/saps", label: "SAPs", tour: "saps" },
    may("dues") && features.dues && { to: "/dues", label: "Dues", tour: "dues" },
    // Issue #106: the camp's jobs, elected ones included (Manage jobs).
    may("volunteer") && features.volunteer && { to: "/volunteers", label: "Jobs" },
    may("people") && { to: "/people", label: "People", tour: "people" },
    may("inquiries") &&
      features.join && {
        to: "/inquiries",
        tour: "inquiries",
        label: `Inquiries${loaderData.newInquiries > 0 ? ` (${loaderData.newInquiries} new)` : ""}`,
      },
    may("people", "manage") && {
      to: "/queue",
      tour: "queue",
      label: `Queue${loaderData.openQueue > 0 ? ` (${loaderData.openQueue})` : ""}`,
    },
    may("announcements", "manage") && {
      to: "/announcements",
      label: "Announcements",
      tour: "announcements",
    },
    may("announcements", "manage") && { to: "/dates", label: "Dates", tour: "dates" },
    loaderData.isAdmin && { to: "/admin", label: "Admin", tour: "admin" },
  ].filter((l) => !!l);
  // The second row of links shows for anyone with any of the Lead tools.
  const hasTools = Object.values(loaderData.access).some((level) => level !== "none");
  // The same links as the header, grouped for the phone menu (issue #62).
  const menuGroups: NavGroup[] = [
    {
      title: "You",
      items: [
        { to: "/", label: "Home", end: true },
        ...(loaderData.supportView ? [] : [{ to: "/profile", label: "Profile" }]),
        ...(features.yearbook
          ? [
              { to: "/yearbook", label: "Yearbook", end: true },
              { to: "/yearbook?view=directory", label: "Directory" },
            ]
          : []),
        ...(features.volunteer ? [{ to: "/volunteer", label: "Volunteer" }] : []),
        { to: "/guides", label: "Guides", tour: "guides" },
      ],
    },
    { title: "Camp leads", items: leadLinks.filter((l) => l.to !== "/admin") },
    { title: "Admin", items: leadLinks.filter((l) => l.to === "/admin") },
  ];
  // Signing out (or leaving a support view), in the header and at the foot of the menu. The demo
  // has no sign-in to end.
  const account = (className: string) =>
    loaderData.demo ? null : loaderData.supportView ? (
      <Form method="post" action="/support/leave">
        <button type="submit" className={className}>
          Leave support view
        </button>
      </Form>
    ) : (
      <Form method="post" action="/sign-out">
        <button type="submit" className={className}>
          Sign out
        </button>
      </Form>
    );

  return (
    <div className="min-h-dvh">
      <header className="relative border-b border-dust-light bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <CampMark />
            <CampName />
          </Link>
          {/* Wider screens: the links in the header. Phones: the Menu below (issue #62). */}
          <div className="hidden items-center gap-3 text-sm md:flex">
            {features.yearbook && (
              <>
                <Link to="/yearbook" className="underline-offset-4 hover:underline">
                  Yearbook
                </Link>
                <Link to="/yearbook?view=directory" className="underline-offset-4 hover:underline">
                  Directory
                </Link>
              </>
            )}
            {features.volunteer && (
              <Link to="/volunteer" className="underline-offset-4 hover:underline">
                Volunteer
              </Link>
            )}
            <Link to="/guides" data-tour="guides" className="underline-offset-4 hover:underline">
              Guides
            </Link>
            {/* Issue #30: your name opens your profile ("Profile" on small screens). Support
                access isn't a person, so it has no profile. */}
            {loaderData.supportView ? (
              <span className="hidden text-charcoal sm:inline">{loaderData.name}</span>
            ) : (
              <NavLink
                to="/profile"
                title="Your profile"
                className={({ isActive }) =>
                  `underline-offset-4 hover:underline ${isActive ? "font-semibold underline" : "text-charcoal"}`
                }
              >
                <span className="hidden sm:inline">{loaderData.name}</span>
                <span className="sm:hidden">Profile</span>
              </NavLink>
            )}
            {account("underline")}
          </div>
          <MobileMenu
            groups={menuGroups}
            footer={account(
              "flex min-h-11 w-full items-center rounded-lg px-3 text-base hover:bg-dust-pale",
            )}
          />
        </div>
        {hasTools && (
          <nav
            className="mx-auto hidden max-w-4xl flex-wrap gap-x-4 gap-y-1 px-4 pb-2 text-sm md:flex"
            aria-label="Lead"
          >
            <NavLink to="/" end className={navClass}>
              Home
            </NavLink>
            {leadLinks.map((l) => (
              <NavLink key={l.to} to={l.to} data-tour={l.tour} className={navClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      {loaderData.demo && (
        <div role="status" className="bg-gold-glow px-4 py-2 text-center text-sm">
          {`This is a demo camp with made-up people, seen as ${loaderData.demo === "admin" ? "an" : "a"} ${DEMO_ROLE[loaderData.demo].label}. Look around: saving is turned off, and no email is ever sent. `}
          <span className="whitespace-nowrap">
            View as:{" "}
            {DEMO_ROLES.map((r, i) => (
              <span key={r}>
                {i > 0 && " · "}
                {r === loaderData.demo ? (
                  <strong>{DEMO_ROLE[r].label}</strong>
                ) : (
                  <a
                    href={`/demo/enter?as=${r}`}
                    className="font-semibold underline pointer-coarse:inline-block pointer-coarse:py-2"
                  >
                    {DEMO_ROLE[r].label}
                  </a>
                )}
              </span>
            ))}
          </span>
        </div>
      )}
      {loaderData.supportView && (
        <div role="status" className="bg-night px-4 py-2 text-center text-sm text-warm-white">
          {`${productName} support view, read-only, until ${new Date(loaderData.supportView.until).toLocaleString()}. Every page you open is listed in the camp's Activity.`}
        </div>
      )}
      {loaderData.supportGrantUntil && (
        <div role="status" className="bg-gold-glow px-4 py-2 text-center text-sm">
          {`${productName} support can see this camp (read-only) until ${new Date(loaderData.supportGrantUntil).toLocaleString()}. `}
          <Link to="/admin/support" className="font-semibold underline">
            End it or see details
          </Link>
        </div>
      )}
      {loaderData.suspended && (
        <div role="status" className="bg-coral/15 px-4 py-2 text-center text-sm">
          This camp is suspended, so changes are turned off for now. Contact your camp's organizers.
        </div>
      )}
      <main className="mx-auto max-w-4xl px-4 py-6">
        {loaderData.privacyNotice && (
          <Form
            method="post"
            action="/privacy-notice"
            className="mb-6 space-y-3 rounded-xl bg-white p-4 ring-1 ring-gold"
          >
            <h2 className="font-semibold">Who can see what here</h2>
            <WhoSeesWhat
              campName={campName}
              seesPrivate={loaderData.privacyNotice.seesPrivate}
              seesDues={loaderData.privacyNotice.seesDues}
            />
            <p className="text-sm text-charcoal">
              You can read this again any time from your profile.
            </p>
            <button type="submit" className={btn.primary}>
              Got it
            </button>
          </Form>
        )}
        <Outlet />
        {loaderData.orientation && pathname === "/" && (
          <Orientation
            level={loaderData.orientation.level}
            local={loaderData.orientation.local}
            start={"start" in loaderData.orientation ? loaderData.orientation.start : null}
            hold={!!loaderData.privacyNotice || !!askDirectory}
          />
        )}
      </main>
      <footer className="mx-auto max-w-4xl px-4 pb-8 text-xs text-charcoal">
        {campName} runs this site. {productName} hosts it. {BM_DISCLAIMER}
        {loaderData.feedbackOn &&
          !loaderData.demo &&
          !loaderData.supportView &&
          pathname !== "/feedback" && (
            <>
              {" "}
              <Link
                to={`/feedback?from=${encodeURIComponent(pathname)}`}
                className="font-semibold underline"
              >
                {`Send feedback about ${productName}`}
              </Link>
            </>
          )}
        <div className="mt-2">
          <LegalLinks />
        </div>
      </footer>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const page = accessErrorPage(error);
  if (page) return page;
  throw error;
}
