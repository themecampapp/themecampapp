// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form } from "react-router";
import { AuthCard, buttonClass } from "~/components/AuthCard";
import { pageTitle, useCamp } from "~/lib/camp";
import { getWriteDb } from "~/lib/context.server";
import { confirmRequest, type RequestKind, viewRequest } from "~/lib/data-requests.server";
import type { Route } from "./+types/confirm.request.$token";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Confirm your request") }];
}

export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
}

// R45a: the link emailed to whoever asked Theme Camp App for an export, a camp deletion or a
// login deletion. Viewing it confirms nothing; the button does.
export async function loader({ params, context }: Route.LoaderArgs) {
  return viewRequest(getWriteDb(context), params.token);
}

export async function action({ params, context }: Route.ActionArgs) {
  return { confirmed: await confirmRequest(getWriteDb(context), params.token) };
}

function what(kind: RequestKind, camp: string, email: string, product: string) {
  return kind === "export"
    ? `a full copy of ${camp}'s data. Its Admins will be able to download it from the camp's Admin pages for 7 days.`
    : kind === "delete_camp"
      ? `deleting ${camp} and everything in it. The camp closes as soon as ${product} acts on this. For 30 days you can ask for it back; after that its data is gone for good.`
      : `deleting your ${product} login (${email}). Your name and contact details are removed from every camp you're in, and you won't be able to sign in any more. This can't be undone.`;
}

export default function ConfirmRequest({ loaderData, actionData }: Route.ComponentProps) {
  const { campName, productName } = useCamp();
  if (actionData) {
    return actionData.confirmed ? (
      <AuthCard title="Confirmed">
        <p className="text-sm text-charcoal">
          {`Thanks. ${productName} will carry out your request and let you know when it's done.`}
        </p>
      </AuthCard>
    ) : (
      <AuthCard title="This link doesn't work any more">
        <p className="text-sm text-charcoal">
          {`It has expired or was already used. Ask ${productName} to send a new one.`}
        </p>
      </AuthCard>
    );
  }
  if (loaderData.state === "invalid") {
    return (
      <AuthCard title="This link doesn't work">
        <p className="text-sm text-charcoal">
          {`It has expired or isn't for this camp. Ask ${productName} to send a new one.`}
        </p>
      </AuthCard>
    );
  }
  if (loaderData.state === "confirmed") {
    return (
      <AuthCard title="Already confirmed">
        <p className="text-sm text-charcoal">You've confirmed this request. Nothing more to do.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Confirm your request">
      <p className="mb-4 text-sm text-charcoal">
        {`You asked ${productName} for ${what(loaderData.kind, campName, loaderData.email, productName)}`}
      </p>
      <Form method="post">
        <button type="submit" className={buttonClass}>
          Yes, go ahead
        </button>
      </Form>
      <p className="mt-3 text-xs text-charcoal">
        If you didn't ask for this, just close this page.
      </p>
    </AuthCard>
  );
}
