// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { btn, Field, fileInput, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import {
  addPasses,
  deletePass,
  formatSapDay,
  getSapDays,
  listPasses,
  MAX_PDF_BYTES,
  removePassPdf,
  setPassPdf,
  setSapDays,
} from "~/lib/data/sap.server";
import { formError } from "~/lib/errors";
import { readUpload } from "~/lib/upload.server";
import type { Route } from "./+types/_app.admin.saps";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "SAPs · Admin") }];
}

// The Setup Access Passes Burning Man allocated to the camp: add them by day with their serial
// numbers, and upload each pass's PDF. Leads assign them on the SAPs page.
export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const passes = await listPasses(db);
  const sapDays = (await getSapDays(db)).map((value) => ({ value, label: formatSapDay(value) }));
  const days = new Map<string, typeof passes>();
  for (const p of passes) days.set(p.validDate, [...(days.get(p.validDate) ?? []), p]);
  return {
    sapDays,
    days: [...days.entries()].map(([date, list]) => ({
      date,
      label: formatSapDay(date),
      passes: list,
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const passId = String(form.get("passId") ?? "");
  const done = (msg: string) => redirect(`/admin/saps?notice=${encodeURIComponent(msg)}`);
  try {
    switch (form.get("intent")) {
      case "days": {
        const current = form.getAll("day").map(String);
        const add = String(form.get("addDay") ?? "");
        const remove = String(form.get("removeDay") ?? "");
        await setSapDays(
          db,
          viewer,
          [...current, add].filter((d) => d && d !== remove),
        );
        return done("SAP days saved.");
      }
      case "add": {
        const r = await addPasses(db, viewer, {
          date: String(form.get("date") ?? ""),
          serials: String(form.get("serials") ?? ""),
        });
        return done(
          `Added ${r.added} ${r.added === 1 ? "pass" : "passes"}.${r.skipped ? ` ${r.skipped} already in stock.` : ""}`,
        );
      }
      case "pdf": {
        const file = form.get("pdf");
        if (!(file instanceof File)) return { error: "Choose the pass's PDF first." };
        await setPassPdf(
          db,
          env,
          context.get(cloudflareContext).camp.id,
          viewer,
          passId,
          await readUpload(file, MAX_PDF_BYTES, "sap_pdf_too_large"),
        );
        return done("PDF uploaded.");
      }
      case "remove_pdf":
        await removePassPdf(db, env, viewer, passId);
        return done("PDF removed.");
      case "delete":
        await deletePass(db, env, viewer, passId);
        return done("Pass deleted.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

export default function AdminSaps({ loaderData, actionData }: Route.ComponentProps) {
  const { days, sapDays } = loaderData;
  const [params] = useSearchParams();
  const busy = useNavigation().state === "submitting";
  return (
    <section className="max-w-3xl space-y-6">
      <PageHeader title="Setup Access Passes">
        <Link to="/saps" className={btn.secondary}>
          Requests
        </Link>
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        The passes Burning Man allocated to the camp. Each is for one arrival day. Upload each
        pass's PDF; the camper it's assigned to can download it from their home page. PDFs are
        private: only that camper and Leads can open them.
      </p>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">SAP days this season</h2>
        <p className="text-sm text-charcoal">
          The days campers can pick on their RSVP, and that passes can be for. Each new season
          starts with none.
        </p>
        <input type="hidden" name="intent" value="days" />
        {sapDays.length === 0 ? (
          <p className="text-sm">None yet: campers see "not announced yet".</p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm">
            {sapDays.map((d) => (
              <li
                key={d.value}
                className="flex items-center gap-2 rounded-full bg-dust-pale px-3 py-1 ring-1 ring-dust"
              >
                <input type="hidden" name="day" value={d.value} />
                {d.label}
                <button
                  type="submit"
                  name="removeDay"
                  value={d.value}
                  aria-label={`Remove ${d.label}`}
                  className="text-coral-ink"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" name="addDay" aria-label="Add a day" className={`${input} w-48`} />
          <button type="submit" className={btn.secondary}>
            Add day
          </button>
        </div>
      </Form>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Add passes</h2>
        <input type="hidden" name="intent" value="add" />
        <Field label="Day the passes are for">
          <select name="date" required className={`${input} w-auto`}>
            {sapDays.length === 0 && <option value="">Set the SAP days first</option>}
            {sapDays.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Serial numbers" hint="One per line (or separated by commas).">
          <textarea name="serials" rows={4} required className={`${input} font-mono text-sm`} />
        </Field>
        <button type="submit" className={btn.primary}>
          Add passes
        </button>
      </Form>

      {days.length === 0 ? (
        <Notice>No passes yet. Add them above once Burning Man allocates them.</Notice>
      ) : (
        days.map((d) => (
          <div key={d.date} className="space-y-2">
            <h2 className="font-semibold">
              {d.label}{" "}
              <span className="font-normal text-charcoal">
                {`(${d.passes.length} · ${d.passes.filter((p) => !p.holderName).length} unassigned)`}
              </span>
            </h2>
            <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
              {d.passes.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <span className="min-w-28 font-mono text-sm">{p.serial}</span>
                  <span className="min-w-32 flex-1 text-sm">
                    {p.holderName ? (
                      <Link to={`/people/${p.holderPersonId}`} className="underline">
                        {p.holderName}
                      </Link>
                    ) : (
                      <span className="text-charcoal">Unassigned</span>
                    )}
                  </span>
                  {p.hasPdf ? (
                    <span className="flex items-center gap-2 text-sm">
                      <a href={`/saps/pass/${p.id}/pdf`} className="underline">
                        PDF
                      </a>
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove_pdf" />
                        <input type="hidden" name="passId" value={p.id} />
                        <button type="submit" className="text-charcoal underline">
                          remove
                        </button>
                      </Form>
                    </span>
                  ) : (
                    <Form
                      method="post"
                      encType="multipart/form-data"
                      className="flex items-center gap-2 text-sm"
                    >
                      <input type="hidden" name="intent" value="pdf" />
                      <input type="hidden" name="passId" value={p.id} />
                      <input
                        type="file"
                        name="pdf"
                        accept="application/pdf"
                        required
                        aria-label={`PDF for ${p.serial}`}
                        className={fileInput}
                      />
                      <button type="submit" className={btn.secondary} disabled={busy}>
                        Upload
                      </button>
                    </Form>
                  )}
                  {!p.holderName && (
                    <Form
                      method="post"
                      onSubmit={(e) => {
                        if (!confirm(`Delete pass ${p.serial}?`)) e.preventDefault();
                      }}
                    >
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="passId" value={p.id} />
                      <button type="submit" className="text-sm text-coral-ink underline">
                        Delete
                      </button>
                    </Form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
