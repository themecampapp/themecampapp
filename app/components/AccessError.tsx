// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactElement } from "react";
import { Form, isRouteErrorResponse, Link } from "react-router";
import { AuthCard } from "./AuthCard";

// The pages for "signed in but not a member", "not allowed" and "no such page". The _app layout's middleware
// throws these before any loader runs, so the root route's boundary can be the one to render
// them; both boundaries use this.
export function accessErrorPage(error: unknown): ReactElement | null {
  if (isRouteErrorResponse(error) && error.data?.reason === "not_member") {
    return (
      <AuthCard title="You're not on the camp list yet">
        <p className="mb-4 text-sm text-charcoal">
          You're signed in, but this email isn't linked to an active membership of this camp. If you
          think it should be, ask a camp lead to check your invite.
        </p>
        <Form method="post" action="/sign-out">
          <button type="submit" className="text-sm font-semibold underline">
            Sign out
          </button>
        </Form>
      </AuthCard>
    );
  }
  if (isRouteErrorResponse(error) && error.data?.reason === "demo_read_only") {
    return (
      <AuthCard title="Saving is off in the demo">
        <p className="text-sm text-charcoal">
          This is a demo camp with made-up people, so nothing you change is saved. Everything else
          works the way it would for your camp.
        </p>
        <Link to="/" className="mt-4 inline-block text-sm font-semibold underline">
          Back to the demo
        </Link>
      </AuthCard>
    );
  }
  if (isRouteErrorResponse(error) && error.data?.reason === "support_ended") {
    return (
      <AuthCard title="Support access has ended">
        <p className="text-sm text-charcoal">
          The camp's support access expired or was revoked. Ask one of its Admins for a new grant,
          then open the camp again from the operator console.
        </p>
      </AuthCard>
    );
  }
  // Issue #97: a mistyped address, an old link, or a page whose feature the camp switched off.
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <AuthCard title="We couldn't find that page">
        <p className="text-sm text-charcoal">
          Check the address for a typo. If you followed a link, it may be out of date, or the page
          may have moved.
        </p>
        <Link to="/" className="mt-4 inline-block text-sm font-semibold underline">
          Go to the home page
        </Link>
      </AuthCard>
    );
  }
  if (isRouteErrorResponse(error) && error.status === 403) {
    return (
      <AuthCard title="Not allowed">
        <p className="text-sm text-charcoal">You don't have access to that page.</p>
        <Link to="/" className="mt-4 inline-block text-sm font-semibold underline">
          Back home
        </Link>
      </AuthCard>
    );
  }
  return null;
}
