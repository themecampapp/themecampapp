// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { DailyBars, MetricTable } from "../components/UsageCharts";
import {
  consoleError,
  getCamp,
  openSupport,
  setLimits,
  setStatus,
  statusEmail,
  supportStatus,
} from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import { restoreCamp } from "../lib/data-rights.server";
import { sendPlatformMail } from "../lib/mail.server";
import { campDetail, campUsage, usageToday } from "../lib/usage.server";
import type { Route } from "./+types/ops.camps.$id";

// One camp: its counts, its sending limits, and suspend or restore (R16).
export async function loader({ params, context }: Route.LoaderArgs) {
  const { sql, env } = context.get(opsContext);
  const camp = await getCamp(sql, params.id);
  if (!camp) throw data({ reason: "not_found" }, { status: 404 });
  return {
    camp,
    domain: env.PLATFORM_DOMAIN,
    support: await supportStatus(sql, params.id),
    usage: campDetail(await campUsage(sql, 30, camp.id), await usageToday(sql)),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { sql, env, operator, waitUntil } = context.get(opsContext);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) =>
    redirect(`/ops/camps/${params.id}?notice=${encodeURIComponent(msg)}`);
  try {
    switch (get("intent")) {
      case "open_support": {
        // The browser posts the token to the camp itself (below), so it never sits in a URL.
        const { slug, token } = await openSupport(sql, operator, params.id);
        return { enter: { action: `https://${slug}.${env.PLATFORM_DOMAIN}/support/enter`, token } };
      }
      case "restore_deleted":
        await restoreCamp(sql, operator, params.id, get("reason"));
        return done("Deletion cancelled; the camp is open again.");
      case "limits":
        await setLimits(sql, operator, params.id, {
          dailySendCap: get("dailySendCap"),
          sendingPaused: form.get("sendingPaused") === "on",
        });
        return done("Limits saved.");
      case "suspend":
      case "restore": {
        const to = get("intent") === "suspend" ? "suspended" : "active";
        const result = await setStatus(sql, operator, params.id, to, get("reason"));
        const mail = statusEmail(to, result, env.PLATFORM_DOMAIN, result.reason, env.PRODUCT_NAME);
        // After the change is committed; a mail failure doesn't undo it.
        waitUntil(sendPlatformMail(env, sql, result.adminEmails, mail.subject, mail.text));
        return done(
          `${to === "suspended" ? "Suspended" : "Restored"}. ${result.adminEmails.length} Admin${result.adminEmails.length === 1 ? "" : "s"} emailed.`,
        );
      }
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    // Not a camp: the page's 404, not a form message.
    if (
      e &&
      typeof e === "object" &&
      "data" in e &&
      (e as { data?: { reason?: string } }).data?.reason === "camp_not_found"
    ) {
      throw data({ reason: "not_found" }, { status: 404 });
    }
    return consoleError(e);
  }
}

// Posts the support token to the camp's /support/enter as soon as it arrives (a plain form:
// it goes to another origin), with the button as the fallback.
function EnterSupport({ action, token }: { action: string; token: string }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.submit();
  }, []);
  return (
    <form ref={form} method="post" action={action} className="rounded border p-4">
      <input type="hidden" name="token" value={token} />
      <p className="mb-2 text-sm">Opening the camp…</p>
      <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
        Open the camp
      </button>
    </form>
  );
}

export default function CampPage({ loaderData, actionData }: Route.ComponentProps) {
  const { camp, domain, support } = loaderData;
  const enter = actionData && "enter" in actionData ? actionData.enter : null;
  const [params] = useSearchParams();
  const suspended = camp.status === "suspended";
  if (camp.status === "pending_deletion") {
    return (
      <section className="max-w-2xl space-y-5">
        <Link to="/ops" className="text-sm underline">
          ← Camps
        </Link>
        <h1 className="text-xl font-bold">{camp.name}</h1>
        {actionData && "error" in actionData && actionData.error && (
          <p className="rounded bg-red-50 p-3 text-sm">{actionData.error}</p>
        )}
        <p className="rounded bg-red-50 p-3 text-sm">
          {`Marked for deletion. It's closed now, and its rows and files are deleted for good after ${camp.deleteAfter?.slice(0, 10) ?? "30 days"}.`}
        </p>
        <Form method="post" className="space-y-3 rounded border p-4">
          <h2 className="font-semibold">Cancel the deletion</h2>
          <input type="hidden" name="intent" value="restore_deleted" />
          <label className="block text-sm">
            Why (for the logs)
            <textarea name="reason" required rows={2} className="mt-1 w-full rounded border p-2" />
          </label>
          <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
            Restore the camp
          </button>
        </Form>
      </section>
    );
  }
  return (
    <section className="max-w-2xl space-y-5">
      <Link to="/ops" className="text-sm underline">
        ← Camps
      </Link>
      <h1 className="text-xl font-bold">{camp.name}</h1>
      <p className="text-sm opacity-70">{`${camp.slug}.${domain} · ${camp.kind} · ${camp.status} · created ${camp.createdAt.slice(0, 10)}`}</p>
      {params.get("notice") && (
        <p className="rounded bg-green-50 p-3 text-sm">{params.get("notice")}</p>
      )}
      {actionData && "error" in actionData && actionData.error && (
        <p className="rounded bg-red-50 p-3 text-sm">{actionData.error}</p>
      )}
      {enter && <EnterSupport action={enter.action} token={enter.token} />}

      <Usage usage={loaderData.usage} />

      <div className="space-y-2 rounded border p-4">
        <h2 className="font-semibold">Support access</h2>
        {support ? (
          <>
            <p className="text-sm">{`The camp's Admins granted read-only access until ${support.until.slice(0, 16)} UTC. Every page you open is listed in their Activity.`}</p>
            <Form method="post">
              <input type="hidden" name="intent" value="open_support" />
              <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
                Open the camp (read-only)
              </button>
            </Form>
          </>
        ) : (
          <p className="text-sm opacity-80">
            No access. The camp's Admins can grant it under Admin → Support access.
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {[
          ["Active members", camp.members],
          ["Pending invites", camp.invitesPending],
          ["Emails sent, 7 days", camp.emailsSent7d],
          ["Bounces, 7 days", camp.bounces7d],
          ["Complaints, 7 days", camp.complaints7d],
          ["Last activity", camp.lastActivity?.slice(0, 16) ?? "—"],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded border p-2">
            <dt className="text-xs opacity-70">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      <Form method="post" className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">Email limits</h2>
        <input type="hidden" name="intent" value="limits" />
        <label className="block text-sm">
          Daily limit on invites and nudges
          <input
            type="number"
            name="dailySendCap"
            min={0}
            max={10000}
            defaultValue={camp.dailySendCap}
            className="ml-2 w-28 rounded border px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="sendingPaused" defaultChecked={camp.sendingPaused} />
          Pause the camp's email (sign-in links still go)
        </label>
        <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
          Save limits
        </button>
      </Form>

      <Form method="post" className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">{suspended ? "Restore the camp" : "Suspend the camp"}</h2>
        <p className="text-sm opacity-80">
          {suspended
            ? "Everything works again. The Admins are emailed with your note."
            : "Members can still sign in and read, and Admins can export, but nothing can change and no email goes except sign-in links. Nothing is deleted. The Admins are emailed the reason."}
        </p>
        <input type="hidden" name="intent" value={suspended ? "restore" : "suspend"} />
        <label className="block text-sm">
          {suspended ? "Note to the Admins" : "Reason (sent to the Admins)"}
          <textarea
            name="reason"
            required
            rows={3}
            maxLength={1000}
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
          {suspended ? "Restore" : "Suspend"}
        </button>
      </Form>
    </section>
  );
}

// R74: how this camp uses the app. Numbers, route ids and action names only (R38).
function Usage({ usage }: { usage: Route.ComponentProps["loaderData"]["usage"] }) {
  const series = (key: "views" | "actions" | "problems") =>
    usage.daily.map((d) => ({ day: d.day, value: d[key] }));
  return (
    <div id="usage" className="space-y-4 rounded border p-4">
      <h2 className="font-semibold">Usage, last 30 days</h2>
      <p className="text-sm">{`${usage.active7} members active in the last 7 days, ${usage.active30} in the last 30.`}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <DailyBars label="Page views" days={series("views")} />
        <DailyBars label="Actions" days={series("actions")} />
        <DailyBars label="Server and browser errors" days={series("problems")} />
      </div>
      <MetricTable title="Pages viewed (route)" rows={usage.groups.pages} />
      <MetricTable title="Features used (audit action)" rows={usage.groups.features} />
      <MetricTable title="Sign-in" rows={usage.groups.signIn} />
      <MetricTable
        title="Problems (status:code:route, client_error:type:route)"
        rows={usage.groups.problems}
        empty="None."
      />
      <MetricTable title="Email" rows={usage.groups.email} />
    </div>
  );
}
