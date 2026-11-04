// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";
import { AuthCard, buttonClass } from "~/components/AuthCard";
import { pageTitle } from "~/lib/camp";
import type { Route } from "./+types/sign-in.error";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Link expired") }];
}

// One page for every failure (expired, already used, not invited) so nothing is revealed.
export default function SignInError() {
  return (
    <AuthCard title="That link didn't work">
      <p className="mb-5 text-sm text-charcoal">
        Sign-in links work once and expire after 15 minutes. Request a fresh one and use it right
        away.
      </p>
      <Link to="/sign-in" className={`${buttonClass} block text-center`}>
        Send a new link
      </Link>
    </AuthCard>
  );
}
