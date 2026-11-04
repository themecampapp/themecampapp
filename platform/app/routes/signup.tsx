// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { pilotAgreementOn } from "~/lib/legal";
import { verifyTurnstile } from "../../../app/lib/turnstile.server";
import { publicContext, signupContext } from "../lib/context.server";
import { CAMP_SIZE_LABEL, CAMP_SIZES } from "../lib/signup";
import { type SignupInput, signupYears, submitSignup } from "../lib/signup.server";
import type { Route } from "./+types/signup";

// Issue #73: camps ask to join the pilot (signup.<domain> redirects here). Requests wait in the
// console for the operator; approving one creates the camp and emails its Admins.

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `Bring your camp to ${loaderData?.product ?? ""}` },
  { name: "robots", content: "noindex" },
];

const ADMIN_ROWS = 3;

// What a refused request says, in the page's voice.
const MESSAGES: Record<string, string> = {
  camp_name_needed: "Enter your camp's name.",
  camp_name_too_long: "Keep the camp's name under 80 characters.",
  slug_format:
    "The address can use lowercase letters, digits and single hyphens (2 to 40 of them), starting and ending with a letter or digit.",
  slug_reserved: "That address is reserved. Please choose another.",
  slug_taken: "A camp already has that address. Please choose another.",
  admin_name_needed: "Enter each organizer's name.",
  admin_email_needed:
    "Enter at least one organizer's name and email address, and check each email.",
  admin_email_twice: "Each organizer needs their own email address.",
  too_many_admins: "List up to 5 organizers. More can be added in the app later.",
  year_range: "Choose the season you're planning.",
  bad_size: "Choose your camp's size from the list.",
  note_too_long: "Keep the note under 1,000 characters.",
};

function configured(env: PlatformEnv) {
  return !!env.TURNSTILE_SECRET && !!env.TURNSTILE_SITE_KEY;
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(signupContext);
  const { domain, contact, product, env: instance, sourceUrl } = context.get(publicContext);
  return {
    domain,
    contact,
    product,
    sourceUrl,
    pilotAgreement: pilotAgreementOn(instance),
    open: configured(env),
    siteKey: env.TURNSTILE_SITE_KEY,
    years: signupYears(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, sql, ip } = context.get(signupContext);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "").slice(0, 2000);
  const input: SignupInput = {
    campName: get("campName"),
    slug: get("slug"),
    admins: Array.from({ length: ADMIN_ROWS }, (_, i) => ({
      name: get(`adminName${i}`),
      email: get(`adminEmail${i}`),
    })),
    seasonYear: get("seasonYear"),
    campSize: get("campSize"),
    note: get("note"),
  };
  const fail = (error: string) => data({ error, values: input }, { status: 400 });
  if (!configured(env)) return fail("Sign-ups aren't open yet. Please email us instead.");
  if (env.SIGNUP_LIMITER && !(await env.SIGNUP_LIMITER.limit({ key: ip ?? "unknown" })).success) {
    return fail("That's a lot of requests at once. Please wait a minute and try again.");
  }
  const human = await verifyTurnstile({
    secret: env.TURNSTILE_SECRET as string,
    token: get("cf-turnstile-response"),
    ip,
    expectedHostname: new URL(request.url).hostname,
    expectedAction: "signup",
  });
  if (!human) return fail("We couldn't confirm you're a person. Please try the check again.");
  try {
    await submitSignup(sql, env, input);
  } catch (e) {
    const reason = (e as { data?: { reason?: string } })?.data?.reason;
    if (reason && MESSAGES[reason]) return fail(MESSAGES[reason]);
    throw e;
  }
  return redirect("/signup/thanks");
}

const field = "mt-1 block w-full rounded-lg px-3 py-2 ring-1 ring-black/20";
const label = "block text-sm font-semibold";
const hint = "mt-1 text-xs opacity-75";

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const { domain, contact, open, siteKey, years, sourceUrl } = loaderData;
  const v = actionData?.values;
  const busy = useNavigation().state !== "idle";
  // Turnstile's script fills in its widget as soon as it loads. Added after hydration, so React
  // never finds a widget it didn't render.
  useEffect(() => {
    if (!open || document.querySelector("script[data-turnstile]")) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.dataset.turnstile = "";
    document.head.appendChild(script);
  }, [open]);
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-10">
      <header className="space-y-3">
        <Link to="/" className="text-sm underline">
          {loaderData.product}
        </Link>
        <h1 className="text-3xl font-bold">{`Bring your camp to ${loaderData.product}`}</h1>
        <p>
          {`${loaderData.product} is in a free pilot with a growing group of Burning Man theme camps. Tell us about your camp below. Once we approve your request, each organizer you list gets an email to sign in and set up the camp.`}
        </p>
        <p className="text-sm">
          Want to look first?{" "}
          <a href={`https://demo.${domain}`} className="underline">
            Try the demo camp
          </a>
          .
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">The pilot, in short</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            It's free, and the people who build it are committed to keeping it free for as long as
            we have the time and energy to run it. We may one day ask for donations to help cover
            costs, but giving will always be optional.
            {sourceUrl && (
              <>
                {" The code is "}
                <a href={sourceUrl} className="underline">
                  open source
                </a>
                {", so you can always run your own copy."}
              </>
            )}
          </li>
          <li>
            Support is best effort, on our Discord and by email. There's no guaranteed uptime or
            response time.
          </li>
          <li>
            The app is new and will change. We'll tell you before we remove anything you rely on.
          </li>
          <li>
            Either of us can end the pilot at any time. If we do, your Admins get at least 30 days'
            notice and a full export of your camp's data.
          </li>
          {loaderData.pilotAgreement && (
            <li>
              Your first Admin accepts the full{" "}
              <Link to="/legal/pilot-agreement" className="underline">
                pilot agreement
              </Link>{" "}
              when they first sign in.
            </li>
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">Your camp's data</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            {`Your camp's data belongs to your camp. ${loaderData.product} uses it only to run your camp's app. We never sell or share your campers' information, or use it for anything else.`}
          </li>
          <li>
            Every camp is walled off from every other. The database itself refuses to show one
            camp's records to another camp, and that's tested on every change and checked on the
            live site every day.
          </li>
          <li>
            We don't look at your camp's information unless one of your Admins grants us support
            access. Every page we open is then listed for your Admins to see.
          </li>
          <li>
            It's backed up daily, encrypted, for 90 days. Your Admins can ask for a full export, or
            for the camp to be deleted, at any time.
          </li>
        </ul>
        <p className="text-sm">
          More in our{" "}
          <Link to="/legal/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link to="/legal/data-handling" className="underline">
            How we handle data
          </Link>
          .
        </p>
      </section>

      {!open ? (
        <p className="rounded-lg p-4 ring-1 ring-black/10">
          {`Sign-ups aren't open yet. Email ${contact} and we'll set your camp up.`}
        </p>
      ) : (
        <Form method="post" className="space-y-5 rounded-xl p-5 ring-1 ring-black/10">
          <h2 className="text-xl font-bold">Your camp</h2>
          {actionData?.error && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {actionData.error}
            </p>
          )}
          <div>
            <label className={label} htmlFor="campName">
              Camp name
            </label>
            <input
              id="campName"
              name="campName"
              required
              maxLength={80}
              defaultValue={v?.campName}
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="slug">
              Your camp's web address
            </label>
            <div className="mt-1 flex items-center gap-1">
              <input
                id="slug"
                name="slug"
                required
                maxLength={40}
                pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?"
                placeholder="dusty-owls"
                autoCapitalize="none"
                defaultValue={v?.slug}
                className="block w-full min-w-0 rounded-lg px-3 py-2 ring-1 ring-black/20"
              />
              <span className="shrink-0 text-sm">{`.${domain}`}</span>
            </div>
            <p className={hint}>Lowercase letters, digits and hyphens.</p>
          </div>

          <fieldset className="space-y-3">
            <legend className={label}>Organizers</legend>
            <p className={hint}>
              The camp's first Admins. Each gets an email to sign in once we approve the request.
              They can add more Admins and Leads in the app.
            </p>
            {Array.from({ length: ADMIN_ROWS }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows
              <div key={i} className="grid gap-2 sm:grid-cols-2">
                <input
                  name={`adminName${i}`}
                  aria-label={`Organizer ${i + 1} name`}
                  placeholder={i === 0 ? "Name" : "Name (optional)"}
                  required={i === 0}
                  maxLength={80}
                  defaultValue={v?.admins[i]?.name}
                  className={field}
                />
                <input
                  name={`adminEmail${i}`}
                  type="email"
                  aria-label={`Organizer ${i + 1} email`}
                  placeholder={i === 0 ? "Email" : "Email (optional)"}
                  required={i === 0}
                  maxLength={254}
                  defaultValue={v?.admins[i]?.email}
                  className={field}
                />
              </div>
            ))}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="seasonYear">
                The burn you're planning for
              </label>
              <select
                id="seasonYear"
                name="seasonYear"
                defaultValue={v?.seasonYear ?? String(years[0])}
                className={field}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="campSize">
                About how many campers?
              </label>
              <select
                id="campSize"
                name="campSize"
                defaultValue={v?.campSize ?? ""}
                className={field}
              >
                <option value="">Prefer not to say</option>
                {CAMP_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {CAMP_SIZE_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={label} htmlFor="note">
              Anything else we should know? <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id="note"
              name="note"
              rows={3}
              maxLength={1000}
              defaultValue={v?.note}
              className={field}
            />
          </div>

          <div className="cf-turnstile" data-sitekey={siteKey} data-action="signup" />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-black px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send request"}
          </button>
        </Form>
      )}
    </main>
  );
}
