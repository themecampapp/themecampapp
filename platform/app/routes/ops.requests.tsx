// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { consoleError, listCamps } from "../lib/console.server";
import { opsContext } from "../lib/context.server";
import {
  createRequest,
  deleteCamp,
  deleteLogin,
  exportCamp,
  listRequests,
  type RequestKind,
} from "../lib/data-rights.server";
import type { Route } from "./+types/ops.requests";

// R43–R45a: exports, camp deletions and login deletions people ask for. Record one; the
// requester confirms from the emailed link; then carry it out here. Nothing runs unconfirmed.
export async function loader({ context }: Route.LoaderArgs) {
  const { sql } = context.get(opsContext);
  return {
    requests: await listRequests(sql),
    camps: (await listCamps(sql))
      .filter((c) => c.status !== "pending_deletion")
      .map((c) => ({ id: c.id, slug: c.slug })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { sql, env, operator } = context.get(opsContext);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) => redirect(`/ops/requests?notice=${encodeURIComponent(msg)}`);
  try {
    switch (get("intent")) {
      case "record":
        await createRequest(sql, env, operator, {
          campId: get("campId"),
          kind: get("kind"),
          email: get("email"),
        });
        return done("Recorded. The confirmation link is on its way to the requester.");
      case "carry_out": {
        const kind = get("kind") as RequestKind;
        if (kind === "delete_camp") {
          await deleteCamp(sql, operator, get("campId"), get("requestId"));
          return done(
            "The camp is closed and will be deleted for good in 30 days. Restore it from its page until then.",
          );
        }
        if (kind === "delete_login") {
          await deleteLogin(sql, env, operator, get("campId"), get("requestId"));
          return done("The login is deleted, and its person records are anonymized in every camp.");
        }
        if (kind === "export") {
          const { bytes } = await exportCamp(sql, env, operator, get("campId"), get("requestId"));
          return done(
            `Export ready (${Math.ceil(bytes / 1024)} KB). The camp's Admins can download it from Admin → Exports for 7 days.`,
          );
        }
        return { error: "Unknown request." };
      }
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return consoleError(e);
  }
}

const KIND: Record<RequestKind, string> = {
  export: "Full export",
  delete_camp: "Delete the camp",
  delete_login: "Delete a login",
};

export default function Requests({ loaderData, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <section className="space-y-5">
      <h1 className="text-xl font-bold">Data requests</h1>
      {params.get("notice") && (
        <p className="rounded bg-green-50 p-3 text-sm">{params.get("notice")}</p>
      )}
      {actionData?.error && <p className="rounded bg-red-50 p-3 text-sm">{actionData.error}</p>}

      <Form method="post" className="max-w-2xl space-y-3 rounded border p-4">
        <h2 className="font-semibold">Record a request</h2>
        <p className="text-sm opacity-80">
          An export or a camp deletion must come from one of the camp's Admins; a login deletion
          from the person themselves. They're emailed a link to confirm on the camp's site. Exports
          also need the camp to have granted support access.
        </p>
        <input type="hidden" name="intent" value="record" />
        <div className="flex flex-wrap gap-3 text-sm">
          <label>
            Camp
            <select name="campId" className="ml-2 rounded border px-2 py-1">
              {loaderData.camps.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.slug}
                </option>
              ))}
            </select>
          </label>
          <label>
            Asked for
            <select name="kind" className="ml-2 rounded border px-2 py-1">
              {(Object.keys(KIND) as RequestKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Requester's email
            <input type="email" name="email" required className="ml-2 rounded border px-2 py-1" />
          </label>
        </div>
        <button type="submit" className="rounded bg-black px-3 py-1.5 text-sm text-white">
          Record and send the confirmation link
        </button>
      </Form>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2 pr-3">Recorded (UTC)</th>
            <th className="pr-3">Camp</th>
            <th className="pr-3">Asked for</th>
            <th className="pr-3">Status</th>
            <th className="pr-3" />
          </tr>
        </thead>
        <tbody>
          {loaderData.requests.map((r) => (
            <tr key={r.id} className="border-b align-top">
              <td className="py-2 pr-3 whitespace-nowrap">{r.createdAt.slice(0, 16)}</td>
              <td className="pr-3">{r.slug ?? "—"}</td>
              <td className="pr-3">{KIND[r.kind]}</td>
              <td className="pr-3">
                {r.state === "waiting"
                  ? "Waiting for the requester to confirm"
                  : r.state === "expired"
                    ? "Link expired unconfirmed"
                    : r.state === "confirmed"
                      ? "Confirmed"
                      : "Done"}
              </td>
              <td className="pr-3">
                {r.state === "confirmed" && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="carry_out" />
                    <input type="hidden" name="kind" value={r.kind} />
                    <input type="hidden" name="campId" value={r.campId} />
                    <input type="hidden" name="requestId" value={r.id} />
                    <button type="submit" className="rounded bg-black px-3 py-1 text-xs text-white">
                      {r.kind === "export"
                        ? "Make the export"
                        : r.kind === "delete_camp"
                          ? "Delete the camp"
                          : "Delete the login"}
                    </button>
                  </Form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
