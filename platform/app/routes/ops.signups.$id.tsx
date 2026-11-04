// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, Link, redirect } from "react-router";
import { createdNotice } from "../lib/camps.server";
import { consoleError } from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import { CAMP_SIZE_LABEL, MAX_ADMINS } from "../lib/signup";
import { approveSignup, declineSignup, getSignup } from "../lib/signup.server";
import type { Route } from "./+types/ops.signups.$id";

// Issue #73: one camp's sign-up request. Approve it (correcting its name, address, season or
// Admins first if needed), or decline it, with an optional message to its organizers.
export async function loader({ params, context }: Route.LoaderArgs) {
  const { sql, env } = context.get(opsContext);
  const signup = await getSignup(sql, params.id);
  if (!signup) throw data(null, { status: 404 });
  return { signup, domain: env.PLATFORM_DOMAIN };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { sql, env, operator } = context.get(opsContext);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  try {
    if (get("intent") === "approve") {
      const created = await approveSignup(sql, env, operator, params.id, {
        name: get("name"),
        slug: get("slug"),
        year: get("year"),
        admins: Array.from({ length: MAX_ADMINS }, (_, i) => ({
          name: get(`adminName${i}`),
          email: get(`adminEmail${i}`),
        })),
      });
      const notice = createdNotice(created);
      return redirect(`/ops/camps/${created.id}?notice=${encodeURIComponent(notice)}`);
    }
    if (get("intent") === "decline") {
      const { emailed } = await declineSignup(sql, env, operator, params.id, get("message"));
      return redirect(
        `/ops/signups?notice=${encodeURIComponent(emailed ? "Declined; the organizers were emailed." : "Declined.")}`,
      );
    }
    return { error: "Unknown action." };
  } catch (e) {
    return consoleError(e);
  }
}

const field = "mt-1 block w-full rounded border px-2 py-1";

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const { signup: s, domain } = loaderData;
  const pending = s.status === "pending";
  return (
    <section className="max-w-2xl space-y-4">
      <p className="text-sm">
        <Link to="/ops/signups" className="underline">
          ← Sign-ups
        </Link>
      </p>
      <h1 className="text-xl font-bold">{s.campName}</h1>
      {actionData?.error && <p className="rounded bg-red-50 p-3 text-sm">{actionData.error}</p>}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-70">Asked</dt>
        <dd>{new Date(s.createdAt).toLocaleString()}</dd>
        <dt className="opacity-70">Address</dt>
        <dd>
          {`${s.slug}.${domain}`}
          {s.slugTaken && <span className="ml-2 text-red-700">another camp has it now</span>}
        </dd>
        <dt className="opacity-70">Season</dt>
        <dd>{s.seasonYear}</dd>
        <dt className="opacity-70">Size</dt>
        <dd>{s.campSize ? CAMP_SIZE_LABEL[s.campSize] : "Not said"}</dd>
        <dt className="opacity-70">Organizers</dt>
        <dd>
          {s.admins.map((a) => (
            <div key={a.email}>{`${a.name} <${a.email}>`}</div>
          ))}
        </dd>
        <dt className="opacity-70">Note</dt>
        <dd className="whitespace-pre-wrap break-words">{s.note ?? "None"}</dd>
        {!pending && (
          <>
            <dt className="opacity-70">Decision</dt>
            <dd>
              {`${s.status === "approved" ? "Approved" : "Declined"} by ${s.decidedBy ?? "?"}, ${new Date(s.decidedAt ?? s.createdAt).toLocaleString()}`}
              {s.createdCampId && (
                <>
                  {" · "}
                  <Link to={`/ops/camps/${s.createdCampId}`} className="underline">
                    the camp
                  </Link>
                </>
              )}
            </dd>
          </>
        )}
      </dl>

      {pending && (
        <>
          <Form method="post" className="space-y-3 rounded border p-4 text-sm">
            <h2 className="font-semibold">Approve</h2>
            <p className="opacity-80">
              Creates the camp and emails each Admin an invite (Admin, Lead and Treasurer). Correct
              anything first if you need to.
            </p>
            <input type="hidden" name="intent" value="approve" />
            <label className="block">
              Camp name
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={s.campName}
                className={field}
              />
            </label>
            <label className="block">
              Address
              <span className="mt-1 flex items-center gap-1">
                <input
                  name="slug"
                  required
                  maxLength={40}
                  defaultValue={s.slug}
                  className="w-48 rounded border px-2 py-1"
                />
                <span className="opacity-70">{`.${domain}`}</span>
              </span>
            </label>
            <label className="block">
              Season
              <input
                name="year"
                type="number"
                required
                defaultValue={s.seasonYear}
                className="mt-1 block w-28 rounded border px-2 py-1"
              />
            </label>
            <fieldset className="space-y-2">
              <legend>Admins (empty rows are skipped)</legend>
              {Array.from({ length: MAX_ADMINS }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows
                <div key={i} className="grid gap-2 sm:grid-cols-2">
                  <input
                    name={`adminName${i}`}
                    aria-label={`Admin ${i + 1} name`}
                    defaultValue={s.admins[i]?.name}
                    className="rounded border px-2 py-1"
                  />
                  <input
                    name={`adminEmail${i}`}
                    type="email"
                    aria-label={`Admin ${i + 1} email`}
                    defaultValue={s.admins[i]?.email}
                    className="rounded border px-2 py-1"
                  />
                </div>
              ))}
            </fieldset>
            <button type="submit" className="rounded bg-black px-3 py-1.5 text-white">
              Approve: create the camp and invite its Admins
            </button>
          </Form>

          <Form method="post" className="space-y-3 rounded border p-4 text-sm">
            <h2 className="font-semibold">Decline</h2>
            <input type="hidden" name="intent" value="decline" />
            <label className="block">
              Message to the organizers (optional; nothing is sent if it's empty)
              <textarea name="message" rows={4} maxLength={2000} className={field} />
            </label>
            <button type="submit" className="rounded border px-3 py-1.5">
              Decline
            </button>
          </Form>
        </>
      )}
    </section>
  );
}
