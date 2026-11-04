// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { formError } from "~/lib/errors";
import { DURATIONS } from "~/lib/support";
import { grantSupport, recentGrants, revokeSupport, settleExpired } from "~/lib/support.server";
import { emailSupportEnded, emailSupportStarted } from "~/lib/support-mail.server";
import { campReadOnly } from "~/lib/tenancy.server";
import type { Route } from "./+types/_app.admin.support";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Support access · Admin") }];
}

// R39, R40: an Admin lets Theme Camp App support see the camp, read-only, for a set time, and
// can end it early. Every page support looks at is in Activity; the Admins are emailed when
// it starts and ends.
export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const { env, camp } = context.get(cloudflareContext);
  // Ended grants are settled (and the Admins told) here or by the platform's hourly job. Not
  // in a camp that can't be written to (the demo, a suspended camp), which used to make this
  // page fail (#84): an ended grant gives no access anyway, and it's settled once the camp
  // is active again.
  if (!campReadOnly(camp, false) && (await settleExpired(db))) await emailSupportEnded(db, env);
  const grants = await recentGrants(db);
  const now = Date.now();
  return {
    grants: grants.map((g) => ({
      id: g.id,
      createdAt: g.createdAt.toISOString(),
      expiresAt: g.expiresAt.toISOString(),
      state: g.revokedAt ? "revoked" : g.expiresAt.getTime() > now ? "active" : "expired",
      opened: g.opened,
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const done = (msg: string) => redirect(`/admin/support?notice=${encodeURIComponent(msg)}`);
  try {
    if (form.get("intent") === "revoke") {
      if (await revokeSupport(db, viewer)) await emailSupportEnded(db, env);
      return done("Support access ended.");
    }
    const g = await grantSupport(db, viewer, String(form.get("duration") ?? ""));
    if (g.replaced) await emailSupportEnded(db, env);
    await emailSupportStarted(db, env, g.expiresAt);
    return done("Support access granted. Every Admin has been emailed.");
  } catch (e) {
    return formError(e);
  }
}

const LABEL = { "1h": "1 hour", "1d": "1 day", "3d": "3 days", "7d": "7 days" };
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function SupportAccess({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const { productName } = useCamp();
  const running = loaderData.grants.find((g) => g.state === "active");
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Support access" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        {productName} support can't see your camp's members, RSVPs or anything else unless an Admin
        allows it here. Access is read-only: support can look, never change anything. Every page
        support views is listed in{" "}
        <a href="/admin/activity?who=operator" className="underline">
          Activity
        </a>
        , and every Admin is emailed when access starts and ends.
      </p>

      {running ? (
        <div className="space-y-3 rounded-xl bg-gold-glow p-4 ring-1 ring-gold">
          <p className="font-semibold">{`Support can see the camp until ${when(running.expiresAt)}.`}</p>
          <p className="text-sm">
            {running.opened
              ? "Support has opened the camp."
              : "Support hasn't opened the camp yet."}
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="revoke" />
            <button type="submit" className={btn.primary}>
              End support access now
            </button>
          </Form>
        </div>
      ) : (
        <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">Let support see the camp</h2>
          <Field label="For how long">
            <select name="duration" defaultValue="1d" className={`${input} w-40`}>
              {(Object.keys(DURATIONS) as Array<keyof typeof LABEL>).map((d) => (
                <option key={d} value={d}>
                  {LABEL[d]}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className={btn.primary}>
            Grant read-only access
          </button>
        </Form>
      )}

      {loaderData.grants.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">Recent grants</h2>
          <ul className="space-y-1 text-sm">
            {loaderData.grants.map((g) => (
              <li key={g.id}>
                {`${when(g.createdAt)} → ${when(g.expiresAt)} · ${g.state}${g.opened ? " · opened" : ""}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
