// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { sendFeedback } from "~/lib/data/feedback.server";
import { formError } from "~/lib/errors";
import { FEEDBACK_MAX, feedbackPath } from "~/lib/feedback";
import { featureOn } from "~/lib/instance-features";
import type { Route } from "./+types/_app.feedback";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Send feedback") }];
}

// R65: feedback about Theme Camp App, to its operator. Every signed-in page links here with
// the page it came from (`?from=`); only that page's path, with ids taken out, is kept.
// Only where the instance takes feedback (config features.feedback, open-source plan 3.7).
function requireFeedback(context: Route.LoaderArgs["context"]) {
  if (!featureOn(context.get(cloudflareContext).env, "feedback")) {
    throw data(null, { status: 404 });
  }
}

export function loader({ request, context }: Route.LoaderArgs) {
  requireFeedback(context);
  const v = getViewer(context);
  const params = new URL(request.url).searchParams;
  const raw = params.get("from");
  const from = feedbackPath(raw);
  // Ids never stay in the address, even here.
  if (raw !== null && raw !== from) {
    const clean = new URLSearchParams(params);
    clean.set("from", from);
    throw redirect(`/feedback?${clean}`);
  }
  return {
    from,
    canSend: !v.support && !v.demo,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireFeedback(context);
  const form = await request.formData();
  const from = String(form.get("from") ?? "/");
  try {
    const { env } = context.get(cloudflareContext);
    await sendFeedback(getDb(context), env, getViewer(context), {
      from,
      message: String(form.get("message") ?? ""),
    });
  } catch (e) {
    return formError(e);
  }
  return redirect(`/feedback?sent=1&from=${encodeURIComponent(feedbackPath(from))}`);
}

export default function Feedback({ loaderData, actionData }: Route.ComponentProps) {
  const { from, canSend } = loaderData;
  const { productName } = useCamp();
  const [params] = useSearchParams();
  if (params.get("sent")) {
    return (
      <section className="max-w-2xl space-y-4">
        <PageHeader title="Thanks for your feedback" />
        <p>{`It's on its way to ${productName}. We've emailed you a confirmation.`}</p>
        <Link to={from} className={btn.secondary}>
          Back to where you were
        </Link>
      </section>
    );
  }
  return (
    <section className="max-w-2xl space-y-4">
      <PageHeader title="Send feedback" />
      <p className="text-sm">
        {`Tell ${productName} what's confusing, broken or missing. The person who runs ${productName}`}{" "}
        reads it; your camp's Leads don't see it. Along with your words, it records this camp, the
        page you came from and your role (member, Lead, Treasurer or Admin), but not who you are.
      </p>
      <p className="text-sm font-semibold">Please don't include other people's personal details.</p>
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      {canSend ? (
        <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <input type="hidden" name="from" value={from} />
          <Field label="Your feedback" hint={`Sent from ${from}`}>
            <textarea name="message" rows={6} required maxLength={FEEDBACK_MAX} className={input} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn.primary}>
              Send
            </button>
            <Link to={from} className={btn.secondary}>
              Cancel
            </Link>
          </div>
        </Form>
      ) : (
        <Notice tone="info">Feedback can't be sent from the demo or a support view.</Notice>
      )}
    </section>
  );
}
