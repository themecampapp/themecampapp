// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";
import { AuthCard } from "~/components/AuthCard";
import { pageTitle } from "~/lib/camp";
import type { Route } from "./+types/sign-in.check-email";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Check your email") }];
}

// Sign-in links only go to people invited to the camp at this address, so name the address:
// someone at the wrong camp's page otherwise just never gets an email.
export function loader({ request }: Route.LoaderArgs) {
  return { host: new URL(request.url).host };
}

export default function CheckEmail({ loaderData }: Route.ComponentProps) {
  return (
    <AuthCard title="Check your email">
      <p className="text-sm text-charcoal">
        If that address has been invited to the camp at{" "}
        <span className="font-semibold">{loaderData.host}</span>, a sign-in link is on its way. It
        works once and expires in 15 minutes.
      </p>
      <p className="mt-4 text-sm text-charcoal">
        Nothing arrived? Check spam, and check this is your camp's address. Then{" "}
        <Link to="/sign-in" className="font-semibold underline">
          send another link
        </Link>
        , or ask your camp's organizers.
      </p>
    </AuthCard>
  );
}
