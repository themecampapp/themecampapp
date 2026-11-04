// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link } from "react-router";
import { AuthCard, buttonClass } from "~/components/AuthCard";
import { CampName } from "~/components/CampName";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb, getDbForCamp } from "~/lib/context.server";
import { confirmEmailChange } from "~/lib/email-change.server";
import { reasonOf } from "~/lib/errors";
import type { Route } from "./+types/email.confirm";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Confirm your email") }];
}

// Step 2 of a sign-in email change, after the current address approved it (email.approve).
// Public on purpose: the link is opened from the new mailbox, often on another device. The
// token alone authorizes the change. Viewing this page (a GET) never uses it up; only the
// button does, so mail scanners that follow links can't make the change.
// (The loader also runs after the POST, whose URL has no token, so it mustn't redirect.)
export function loader({ request }: Route.LoaderArgs) {
  return { token: new URL(request.url).searchParams.get("token") ?? "" };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const { env } = context.get(cloudflareContext);
  try {
    const { email } = await confirmEmailChange(
      getDb(context),
      env,
      String(form.get("token") ?? ""),
      (camp) => getDbForCamp(context, camp),
    );
    return { ok: true as const, email };
  } catch (e) {
    const reason = reasonOf(e);
    if (reason === "email_unavailable") return { ok: false as const, reason };
    if (reason === "email_change_invalid") return { ok: false as const, reason };
    throw e;
  }
}

export default function ConfirmEmail({ loaderData, actionData }: Route.ComponentProps) {
  if (actionData?.ok) {
    return (
      <AuthCard title="Email updated">
        <p className="mb-4 text-sm text-charcoal">
          {`Your sign-in email is now ${actionData.email}, for every camp you belong to. You've been signed out everywhere: sign in again with the new address.`}
        </p>
        <Link to="/sign-in" className="text-sm font-semibold underline">
          Sign in
        </Link>
      </AuthCard>
    );
  }
  if (actionData) {
    return (
      <AuthCard title="Couldn't change your email">
        <p className="mb-4 text-sm text-charcoal">
          {actionData.reason === "email_unavailable"
            ? "That address is already used by someone else in the app. A camp lead has been told and will sort it out."
            : "This link has expired or was already used. You can request a new one from your profile."}
        </p>
        <Link to="/profile" className="text-sm font-semibold underline">
          Your profile
        </Link>
      </AuthCard>
    );
  }
  if (!loaderData.token) {
    return (
      <AuthCard title="Link incomplete">
        <p className="text-sm text-charcoal">
          Open the full link from the email we sent, or request a new one from your profile.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Confirm your new email">
      <p className="mb-4 text-sm text-charcoal">
        Press the button to use this address for signing in to <CampName />, and to every other camp
        you belong to.
      </p>
      <Form method="post">
        <input type="hidden" name="token" value={loaderData.token} />
        <button type="submit" className={buttonClass}>
          Confirm new email
        </button>
      </Form>
    </AuthCard>
  );
}
