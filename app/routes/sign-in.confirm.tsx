// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import { useEffect, useRef } from "react";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { AuthCard, buttonClass } from "~/components/AuthCard";
import { tokenIsForCamp } from "~/lib/auth.server";
import { logAuthEvent, peekMagicToken } from "~/lib/auth-log.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, defer, getAuth, getSettings, getWriteDb } from "~/lib/context.server";
import type { Db } from "~/lib/db.server";
import { discordWebhook } from "~/lib/instance-features";
import { notifyOperator, signInMessage, signInRole } from "~/lib/notify.server";
import type { Route } from "./+types/sign-in.confirm";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Signing in") }];
}

// The emailed link lands here. A GET never uses up the link (mail scanners follow links);
// the page submits itself in the browser, with a button as the fallback.
export async function loader({ request, context }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw redirect("/sign-in");
  const db = getWriteDb(context);
  const { email, state } = await peekMagicToken(db, token);
  const session = await getAuth(context).api.getSession({ headers: request.headers });
  await logAuthEvent(db, {
    event: "link_opened",
    email: email ?? session?.user.email,
    request,
    detail: { link: state, alreadySignedIn: Boolean(session) },
  });
  // Already signed in (say, a second click on the link): just go in.
  if (session) throw redirect("/");
  return { token };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  if (!token) return redirect("/sign-in/error");
  // The same link sent twice (a press of the button while the automatic submit was still
  // working, on a slow first sign-in): the first one already signed them in, so the second
  // goes in too instead of to "link already used".
  if (await getAuth(context).api.getSession({ headers: request.headers })) return redirect("/");
  const db = getWriteDb(context);
  const { email, state } = await peekMagicToken(db, token);
  // A link issued by another camp never signs anyone in here.
  if (!tokenIsForCamp(token, context.get(cloudflareContext).camp.id)) {
    await logAuthEvent(db, {
      event: "sign_in_failed",
      email,
      request,
      detail: { error: "other_camp", link: state },
    });
    return redirect("/sign-in/error");
  }
  const res = await getAuth(context).api.magicLinkVerify({
    query: { token, callbackURL: "/", errorCallbackURL: "/sign-in/error" },
    headers: request.headers,
    asResponse: true,
  });
  const location = new URL(res.headers.get("Location") ?? "/", "http://x");
  const failed = location.pathname === "/sign-in/error";
  await logAuthEvent(db, {
    event: failed ? "sign_in_failed" : "signed_in",
    email,
    request,
    detail: failed ? { error: location.searchParams.get("error"), link: state } : undefined,
  });
  // Issue #32: tell the operator's Discord, with the camp, role and time only. After the response.
  const { env } = context.get(cloudflareContext);
  const webhook = discordWebhook(env);
  if (!failed && webhook) {
    const at = new Date();
    const camp = (await getSettings(context)).name;
    defer(
      context,
      (async () =>
        notifyOperator(webhook, signInMessage(camp, signInRole(await rolesFor(db, email)), at)))(),
    );
  }
  return res;
}

// The roles of the camp's active person with this email (couples sharing one: all of theirs),
// or null when there's no such person.
async function rolesFor(db: Db, email: string | null): Promise<string[] | null> {
  if (!email) return null;
  const rows = await db.execute<{ role: string | null }>(sql`
    select mr.role from person p
    left join member_role mr on mr.person_id = p.id and mr.revoked_at is null
    where p.active and lower(p.email) = lower(${email})`);
  return rows.length ? rows.flatMap((r) => (r.role ? [r.role] : [])) : null;
}

export default function Confirm() {
  const { token } = useLoaderData<typeof loader>();
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  // A second press would send an already-used link.
  const busy = useNavigation().state !== "idle";
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, []);
  return (
    <AuthCard title="Signing you in…">
      <Form method="post" ref={form}>
        <input type="hidden" name="token" value={token} />
        <p className="mb-4 text-sm text-charcoal">
          This should only take a moment. If nothing happens, press the button.
        </p>
        <button type="submit" className={buttonClass} disabled={busy}>
          {busy ? "Signing you in…" : "Continue signing in"}
        </button>
      </Form>
    </AuthCard>
  );
}
