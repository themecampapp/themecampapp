// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { AuthCard, buttonClass, inputClass } from "~/components/AuthCard";
import { logAuthEvent } from "~/lib/auth-log.server";
import { pageTitle } from "~/lib/camp";
import { clientIp } from "~/lib/client-ip.server";
import { cloudflareContext, getAuth, getWriteDb } from "~/lib/context.server";
import { normalizeEmail } from "~/lib/email";
import { hitRateLimit } from "~/lib/rate-limit.server";
import type { Route } from "./+types/sign-in";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Sign in") }];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The demo camp has no sign-in: anyone can look around it (R67).
export function loader({ context }: Route.LoaderArgs) {
  if (context.get(cloudflareContext).camp.kind === "demo") throw redirect("/demo/enter");
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { error: "Please enter a valid email address." };
  }

  // Every outcome below ends on the same page, so nobody can tell who is invited.
  // Writable even for a suspended camp: signing in still works there.
  const db = getWriteDb(context);
  const perEmail = await hitRateLimit(db, `signin:email:${email}`, { windowSeconds: 3600, max: 5 });
  const perIp = await hitRateLimit(db, `signin:ip:${clientIp(request)}`, {
    windowSeconds: 3600,
    max: 20,
  });
  await logAuthEvent(db, {
    event: "link_requested",
    email,
    request,
    detail: perEmail && perIp ? undefined : { throttled: !perEmail ? "email" : "ip" },
  });
  if (perEmail && perIp) {
    await getAuth(context).api.signInMagicLink({
      body: { email, callbackURL: "/" },
      headers: request.headers,
    });
  }
  return redirect("/sign-in/check-email");
}

export default function SignIn({ actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <AuthCard title="Sign in">
      {params.get("left") === "1" && (
        <p role="status" className="mb-4 rounded-lg bg-dust-pale p-3 text-sm">
          You've left this camp and been signed out here.
        </p>
      )}
      <p className="mb-4 text-sm text-charcoal">
        Enter the email address your invite was sent to. We'll email you a sign-in link.
      </p>
      <Form method="post" className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={params.get("email") ?? ""}
          className={inputClass}
        />
        {actionData?.error && (
          <p role="alert" className="text-sm text-coral-ink">
            {actionData.error}
          </p>
        )}
        <button type="submit" className={buttonClass}>
          Email me a sign-in link
        </button>
      </Form>
      <p className="mt-5 text-sm text-charcoal">
        Not part of camp yet?{" "}
        <a href="/join" className="font-semibold underline">
          Interested in joining?
        </a>
      </p>
    </AuthCard>
  );
}
