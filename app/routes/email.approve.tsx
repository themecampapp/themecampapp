// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form } from "react-router";
import { AuthCard, buttonClass } from "~/components/AuthCard";
import { CampName } from "~/components/CampName";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { approveEmailChange, viewApproval } from "~/lib/email-change.server";
import { reasonOf } from "~/lib/errors";
import type { Route } from "./+types/email.approve";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Approve your email change") }];
}

// Step 1 of a sign-in email change (security review S4), opened from the CURRENT sign-in
// address. Public on purpose, like /email/confirm: the token alone authorizes this step. The
// page (a GET) only shows what was asked; the button does it, so mail scanners can't.
export async function loader({ request, context }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const pending = token ? await viewApproval(getDb(context), token) : null;
  return { token, newEmail: pending?.newEmail ?? null };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const { env } = context.get(cloudflareContext);
  try {
    const { newEmail } = await approveEmailChange(
      getDb(context),
      env,
      String(form.get("token") ?? ""),
    );
    return { ok: true as const, newEmail };
  } catch (e) {
    if (reasonOf(e) === "email_change_invalid") return { ok: false as const };
    throw e;
  }
}

export default function ApproveEmail({ loaderData, actionData }: Route.ComponentProps) {
  if (actionData?.ok) {
    return (
      <AuthCard title="Now confirm the new address">
        <p className="text-sm text-charcoal">
          {`Approved. We've sent a link to ${actionData.newEmail}: open it and press the button there to finish. Until then, nothing has changed.`}
        </p>
      </AuthCard>
    );
  }
  if (actionData || !loaderData.newEmail) {
    return (
      <AuthCard title="This link can't be used">
        <p className="text-sm text-charcoal">
          It has expired, was already used, or a newer change was asked for. You can ask again from
          your profile.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Approve your email change">
      <p className="mb-4 text-sm text-charcoal">
        {`Someone signed in to your account asked to sign in to `}
        <CampName />
        {`, and every other camp you belong to, with ${loaderData.newEmail} instead of this address. Approve it only if that was you.`}
      </p>
      <Form method="post">
        <input type="hidden" name="token" value={loaderData.token} />
        <button type="submit" className={buttonClass}>
          Approve the change
        </button>
      </Form>
    </AuthCard>
  );
}
