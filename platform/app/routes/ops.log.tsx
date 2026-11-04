// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { consoleError, listCamps, operatorLog, recordDatabaseAccess } from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import type { Route } from "./+types/ops.log";

// Everything operators did (R41), and emergency database access, entered by hand (R42).
export async function loader({ context }: Route.LoaderArgs) {
  const { sql } = context.get(opsContext);
  return {
    entries: await operatorLog(sql),
    camps: (await listCamps(sql)).map((c) => ({ id: c.id, slug: c.slug })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { sql, operator } = context.get(opsContext);
  const form = await request.formData();
  try {
    await recordDatabaseAccess(sql, operator, {
      campId: String(form.get("campId") ?? ""),
      detail: String(form.get("detail") ?? ""),
    });
  } catch (e) {
    return consoleError(e);
  }
  return redirect(`/ops/log?notice=${encodeURIComponent("Recorded.")}`);
}

export default function Log({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <section className="space-y-5">
      <h1 className="text-xl font-bold">Operator log</h1>
      {params.get("notice") && (
        <p className="rounded bg-green-50 p-3 text-sm">{params.get("notice")}</p>
      )}
      {actionData?.error && <p className="rounded bg-red-50 p-3 text-sm">{actionData.error}</p>}

      <Form method="post" className="max-w-2xl space-y-3 rounded border p-4">
        <h2 className="font-semibold">Record database access</h2>
        <p className="text-sm opacity-80">
          Direct database access is for emergencies only. Record each time: what you looked at or
          changed, and why.
        </p>
        <label className="block text-sm">
          Camp (if it concerned one)
          <select name="campId" className="ml-2 rounded border px-2 py-1">
            <option value="">None / platform-wide</option>
            {loaderData.camps.map((c) => (
              <option key={c.id} value={c.id}>
                {c.slug}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          What and why
          <textarea
            name="detail"
            required
            rows={3}
            maxLength={2000}
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
          Record
        </button>
      </Form>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2 pr-3">When (UTC)</th>
            <th className="pr-3">Operator</th>
            <th className="pr-3">Camp</th>
            <th className="pr-3">What</th>
          </tr>
        </thead>
        <tbody>
          {loaderData.entries.map((e) => (
            <tr key={e.id} className="border-b align-top">
              <td className="py-2 pr-3 whitespace-nowrap">{e.at.slice(0, 16)}</td>
              <td className="pr-3">{e.operator}</td>
              <td className="pr-3">{e.camp ?? "—"}</td>
              <td className="pr-3">
                <span className="font-semibold">
                  {e.kind === "database_access" ? "Database access" : e.action.replaceAll("_", " ")}
                </span>
                {e.detail && (
                  <span className="block whitespace-pre-line opacity-80">{e.detail}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
