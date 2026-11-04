// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect } from "react-router";
import { createCamp, createdNotice, defaultYear } from "../lib/camps.server";
import { consoleError } from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import type { Route } from "./+types/ops.camps.new";

// R12: a new pilot camp. Its first Admin is invited by email and accepts the pilot agreement
// (R68) the first time they sign in.
export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(opsContext);
  return { domain: env.PLATFORM_DOMAIN, year: defaultYear() };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { sql, env, operator } = context.get(opsContext);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  try {
    const c = await createCamp(sql, env, operator, {
      name: get("name"),
      slug: get("slug"),
      admins: [{ name: get("adminName"), email: get("adminEmail") }],
      year: get("year"),
    });
    const notice = createdNotice(c);
    return redirect(`/ops/camps/${c.id}?notice=${encodeURIComponent(notice)}`);
  } catch (e) {
    return consoleError(e);
  }
}

export default function NewCamp({ loaderData, actionData }: Route.ComponentProps) {
  const field = "mt-1 block w-full rounded border px-2 py-1";
  return (
    <section className="max-w-xl space-y-4">
      <p className="text-sm">
        <Link to="/ops" className="underline">
          Camps
        </Link>
      </p>
      <h1 className="text-xl font-bold">New camp</h1>
      {actionData?.error && <p className="rounded bg-red-50 p-3 text-sm">{actionData.error}</p>}
      <p className="text-sm opacity-80">
        The first Admin gets an email to sign in. They'll accept the pilot agreement, then a setup
        checklist guides them. They become the camp's Admin, Lead and Treasurer.
      </p>
      <Form method="post" className="space-y-3 rounded border p-4 text-sm">
        <label className="block">
          Camp name
          <input name="name" required maxLength={80} className={field} />
        </label>
        <label className="block">
          Address
          <span className="mt-1 flex items-center gap-1">
            <input
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
              maxLength={40}
              className="w-48 rounded border px-2 py-1"
            />
            <span className="opacity-70">{`.${loaderData.domain}`}</span>
          </span>
          <span className="mt-1 block text-xs opacity-70">
            Lowercase letters, digits and hyphens. It can't be changed later during the pilot.
          </span>
        </label>
        <label className="block">
          First Admin's name
          <input name="adminName" required className={field} />
        </label>
        <label className="block">
          First Admin's email
          <input name="adminEmail" type="email" required className={field} />
        </label>
        <label className="block">
          Season
          <input
            name="year"
            type="number"
            required
            defaultValue={loaderData.year}
            className="mt-1 block w-28 rounded border px-2 py-1"
          />
          <span className="mt-1 block text-xs opacity-70">The burn the camp is planning for.</span>
        </label>
        <button type="submit" className="rounded bg-black px-3 py-1.5 text-white">
          Create the camp and invite its Admin
        </button>
      </Form>
    </section>
  );
}
