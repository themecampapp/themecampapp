// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, redirect, useNavigation } from "react-router";
import { AuthCard, buttonClass, inputClass } from "~/components/AuthCard";
import { PageText } from "~/components/PageText";
import { Notice } from "~/components/ui";
import { useCamp } from "~/lib/camp";
import { clientIp } from "~/lib/client-ip.server";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { findGuide } from "~/lib/data/guides.server";
import { parseJoinForm, submitJoin } from "~/lib/data/inquiries.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { verifyTurnstile } from "~/lib/turnstile.server";
import type { Route } from "./+types/join";

export function meta({ matches }: Route.MetaArgs) {
  const camp = (matches.find((m) => m?.id === "root")?.loaderData as { campName?: string })
    ?.campName;
  return [
    { title: `Join ${camp ?? "the camp"}` },
    { name: "description", content: `Interested in camping with ${camp ?? "us"}? Say hello.` },
  ];
}

// The join page is a feature a camp can switch off (R20): then it doesn't exist.
async function requireJoinOn(context: Route.LoaderArgs["context"]) {
  if (!(await getSettings(context)).features.join) {
    throw data({ reason: "not_found" }, { status: 404 });
  }
}

// Until the Turnstile widget is configured, the page says so instead of showing a form that
// can't be submitted.
function configured(env: Env) {
  return (
    !!env.TURNSTILE_SECRET &&
    !!env.TURNSTILE_SITE_KEY &&
    !env.TURNSTILE_SITE_KEY.startsWith("REPLACE")
  );
}

// After joining (and for bots and over-limit IPs, so there's nothing to probe), people get a
// thank-you: on the camp's Welcome guide if it has a public one (see join.thanks.tsx).
const THANKS = "/join/thanks";

export async function loader({ context }: Route.LoaderArgs) {
  await requireJoinOn(context);
  const { env } = context.get(cloudflareContext);
  return {
    siteKey: env.TURNSTILE_SITE_KEY as string,
    open: configured(env),
    texts: await pageTexts(getDb(context), ["join_intro", "join_note_hint"]),
    season: (await getSettings(context)).currentYear,
    welcome: (await findGuide(getDb(context), "welcome"))?.visibility === "public",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  await requireJoinOn(context);
  const { env } = context.get(cloudflareContext);
  if (!configured(env)) return { error: "The join form isn't open yet. Please check back soon." };
  const form = await request.formData();
  const ip = clientIp(request);

  // Bots that fill every field (the honeypot) and over-limit IPs get the normal thank-you.
  if (String(form.get("website") ?? "") !== "") return redirect(THANKS);
  const { success } = await env.JOIN_LIMITER.limit({ key: ip });
  if (!success) return redirect(THANKS);

  const human = await verifyTurnstile({
    secret: env.TURNSTILE_SECRET,
    token: String(form.get("cf-turnstile-response") ?? ""),
    ip,
    expectedHostname: new URL(env.APP_URL).hostname,
    expectedAction: "join",
  });
  if (!human) return { error: "We couldn't confirm you're human. Please try again." };

  const parsed = parseJoinForm(form);
  if ("error" in parsed) return parsed;
  const settings = await getSettings(context);
  await submitJoin(getDb(context), env, parsed.input, settings.inquiryNotify);
  return redirect(THANKS);
}

export default function Join({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state === "submitting";
  const { campName } = useCamp();
  const title = `Interested in joining ${campName}?`;
  if (!loaderData.open) {
    return (
      <AuthCard title={title}>
        <p className="text-sm text-charcoal">
          Our join form opens very soon. Please check back in a day or two.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={title}>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      <p className="mb-4 text-sm text-charcoal">
        {/* The camp's own intro (page wording): plain text, never markup. */}
        <PageText text={loaderData.texts.join_intro} year={loaderData.season} />{" "}
        {loaderData.welcome && (
          <a href="/guides/welcome" className="font-semibold underline">
            More about camp
          </a>
        )}
      </p>
      <Form method="post" className="space-y-3">
        {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
        <label className="block space-y-1">
          <span className="text-sm font-medium">Name</span>
          <input name="name" required maxLength={120} autoComplete="name" className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Playa name (optional)</span>
          <input name="playaName" maxLength={80} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Phone (optional)</span>
          <input name="phone" type="tel" maxLength={40} autoComplete="tel" className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">How did you hear about us?</span>
          <input name="heardFrom" maxLength={200} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Anything you'd like us to know? (optional)</span>
          <textarea name="note" rows={4} maxLength={2000} className={inputClass} />
          {loaderData.texts.join_note_hint && (
            <span className="block text-xs text-charcoal">
              <PageText text={loaderData.texts.join_note_hint} year={loaderData.season} />
            </span>
          )}
        </label>
        {/* Honeypot: hidden from people, tempting to bots. */}
        <div aria-hidden="true" className="hidden">
          <label>
            Website <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <div className="cf-turnstile" data-sitekey={loaderData.siteKey} data-action="join" />
        <button type="submit" className={buttonClass} disabled={busy}>
          {busy ? "Sending…" : "Say hello"}
        </button>
      </Form>
    </AuthCard>
  );
}
