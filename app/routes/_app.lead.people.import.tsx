// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Form, Link, redirect } from "react-router";
import { btn, fileInput, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { MAX_ROWS } from "~/lib/csv-import";
import type { Summary } from "~/lib/data/csv-import.server";
import { applyImport, cancelImport, getImport, startImport } from "~/lib/data/csv-import.server";
import { formError } from "~/lib/errors";
import { mailingLines } from "~/lib/mailing-address";
import type { Route } from "./+types/_app.lead.people.import";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Import people") }];
}

// R31–R33: import people from a CSV file. Upload, look at the preview, then confirm. Leads only
// (the _app.lead layout); support access can't, like every other change.
export async function loader({ request, context }: Route.LoaderArgs) {
  // Issue #78: mailing address columns, for a camp that collects addresses.
  const mailing = (await getSettings(context)).features.mailing;
  const id = new URL(request.url).searchParams.get("batch");
  if (!id) return { batch: null, id: null, mailing };
  const batch = await getImport(getDb(context), id);
  // Gone (confirmed imports stay; unconfirmed ones are removed after a day), or another camp's.
  if (!batch) throw data({ reason: "not_found" }, { status: 404 });
  return { batch, id, mailing };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const intent = form.get("intent");
  const id = String(form.get("batch") ?? "");
  try {
    if (intent === "upload") {
      const file = form.get("file");
      const batch = await startImport(db, viewer, file instanceof File ? file : null);
      return redirect(`/people/import?batch=${batch}`);
    }
    if (intent === "cancel") {
      await cancelImport(db, viewer, id);
      return redirect("/people/import");
    }
    if (intent === "apply") {
      const updates = new Set(
        [...form.entries()]
          .filter(([k, v]) => k.startsWith("row_") && v === "update")
          .map(([k]) => Number(k.slice(4))),
      );
      await applyImport(db, viewer, id, updates);
      return redirect(`/people/import?batch=${id}`);
    }
    return { error: "Unknown action." };
  } catch (e) {
    return formError(e);
  }
}

const cell = (v: string | null) => v ?? "";

export default function ImportPeople({ loaderData, actionData }: Route.ComponentProps) {
  const { batch } = loaderData;
  return (
    <section className="space-y-5">
      <Link to="/people" className="inline-block text-sm underline pointer-coarse:py-2.5">
        ← People
      </Link>
      <PageHeader title="Import people" />
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      {!batch && <Upload mailing={loaderData.mailing} />}
      {batch?.status === "pending" && loaderData.id && <Preview batch={batch} id={loaderData.id} />}
      {batch?.status === "applied" && <Done summary={batch.summary} fileName={batch.fileName} />}
    </section>
  );
}

function Upload({ mailing }: { mailing: boolean }) {
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm">
        Add your people from a spreadsheet. Save it as a CSV file with a heading row and one person
        per row. The columns are <strong>Name</strong> (the only one you must have), Playa name,
        Email, Phone, Home location, and Past years attended (like "2023, 2025")
        {mailing &&
          ", plus an optional mailing address: Street address, Apartment or unit, City, State, ZIP or postal code, and Country (a US ZIP code with no country counts as the United States)"}
        .{" "}
        <Link to="/people/import/template" reloadDocument className="underline">
          Download the template
        </Link>
        .
      </p>
      <p className="text-sm text-charcoal">
        {`You'll see what will happen before anything is saved. Up to ${MAX_ROWS.toLocaleString()} people, 1 MB. Nobody is invited or emailed by importing.`}
      </p>
      <Form
        method="post"
        encType="multipart/form-data"
        className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light"
      >
        <input type="hidden" name="intent" value="upload" />
        <input type="file" name="file" accept=".csv,text/csv" required className={fileInput} />
        <button type="submit" className={btn.primary}>
          Preview the import
        </button>
      </Form>
    </div>
  );
}

type PreviewBatch = Extract<
  NonNullable<Route.ComponentProps["loaderData"]["batch"]>,
  { status: "pending" }
>;

function Preview({ batch, id }: { batch: PreviewBatch; id: string }) {
  const create = batch.rows.filter((r) => r.planned.kind === "create");
  const addresses = batch.rows.some((r) => r.mailingAddress);
  const dupes = batch.rows.filter((r) => r.planned.kind === "duplicate");
  const skipped = batch.rows.filter((r) => r.planned.kind === "skip");
  const flagged = batch.rows.filter((r) => r.flags.length > 0 && r.planned.kind !== "skip");
  return (
    <Form method="post" className="space-y-5">
      <input type="hidden" name="batch" value={id} />
      <p className="text-sm">
        {`From ${batch.fileName}: nothing is saved until you confirm at the bottom. To fix a value, edit the spreadsheet and upload it again.`}
      </p>

      <div className="space-y-2">
        <h2 className="font-semibold">{`New people (${create.length})`}</h2>
        {create.length === 0 ? (
          <p className="text-sm text-charcoal">None.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-dust-light">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-dust-light">
                  <th className="p-2">Row</th>
                  <th className="p-2">Name</th>
                  <th className="p-2">Playa name</th>
                  <th className="p-2">Email</th>
                  <th className="p-2">Phone</th>
                  <th className="p-2">Home</th>
                  {addresses && <th className="p-2">Mailing address</th>}
                  <th className="p-2">Past years</th>
                </tr>
              </thead>
              <tbody>
                {create.map((r) => (
                  <tr key={r.line} className="border-b border-dust-light align-top">
                    <td className="p-2">{r.line}</td>
                    <td className="p-2">{cell(r.legalName)}</td>
                    <td className="p-2">{cell(r.playaName)}</td>
                    <td className="p-2">
                      {cell(r.email)}
                      {r.planned.kind === "create" && r.planned.sharedEmail && (
                        <span className="block text-xs text-coral-ink">
                          Shared with another row
                        </span>
                      )}
                    </td>
                    <td className="p-2">{cell(r.phone)}</td>
                    <td className="p-2">{cell(r.homeLocation)}</td>
                    {addresses && (
                      <td className="p-2">
                        {mailingLines(r.mailingAddress ?? null).map((line) => (
                          <span key={line} className="block">
                            {line}
                          </span>
                        ))}
                      </td>
                    )}
                    <td className="p-2">{r.years.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dupes.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Probably already here (${dupes.length})`}</h2>
          <p className="text-sm text-charcoal">
            Skip the row, or update the person already in the app with the row's details (their
            email is never changed).
          </p>
          <ul className="space-y-2">
            {dupes.map(
              (r) =>
                r.planned.kind === "duplicate" && (
                  <li
                    key={r.line}
                    className="rounded-xl bg-white p-3 text-sm ring-1 ring-dust-light"
                  >
                    <p>
                      {`Row ${r.line}: ${r.legalName}${r.email ? ` · ${r.email}` : ""}`}
                      {" matches "}
                      <Link to={`/people/${r.planned.match.id}`} className="underline">
                        {r.planned.match.name}
                      </Link>
                      {r.planned.by === "email" ? " (same email)" : " (same name)"}
                    </p>
                    <div className="mt-2 flex gap-4">
                      <label className="flex items-center gap-1">
                        <input type="radio" name={`row_${r.line}`} value="skip" defaultChecked />
                        Skip
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="radio" name={`row_${r.line}`} value="update" />
                        Update them
                      </label>
                    </div>
                  </li>
                ),
            )}
          </ul>
        </div>
      )}

      {flagged.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Check these (${flagged.length})`}</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {flagged.map((r) => (
              <li key={r.line}>{`Row ${r.line} (${r.legalName}): ${r.flags.join(" ")}`}</li>
            ))}
          </ul>
        </div>
      )}

      {skipped.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Not imported (${skipped.length})`}</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {skipped.map(
              (r) =>
                r.planned.kind === "skip" && (
                  <li key={r.line}>
                    {r.planned.reason === "no_name"
                      ? `Row ${r.line}: no name.`
                      : `Row ${r.line} (${r.legalName}): already imported from a file before.`}
                  </li>
                ),
            )}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" name="intent" value="apply" className={btn.primary}>
          {`Import ${create.length} ${create.length === 1 ? "person" : "people"}${dupes.length ? " and apply the choices above" : ""}`}
        </button>
        <button type="submit" name="intent" value="cancel" formNoValidate className={btn.secondary}>
          Cancel
        </button>
      </div>
    </Form>
  );
}

function Done({ summary: s, fileName }: { summary: Summary; fileName: string }) {
  return (
    <div className="max-w-2xl space-y-4">
      <Notice tone="ok">
        {`Imported ${fileName}: ${s.created} added, ${s.updated} updated, ${s.skipped + s.alreadyImported} skipped.`}
      </Notice>
      {s.notInvitable.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">{`Not ready to invite yet (${s.notInvitable.length})`}</h2>
          <p className="text-sm text-charcoal">
            They're in the app, but can't be invited until they have an email address of their own.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {s.notInvitable.map((p) => (
              <li key={p.id}>
                <Link to={`/people/${p.id}`} className="underline">
                  {p.name}
                </Link>
                {p.reason === "no_email" ? ": no email" : ": shares an email with someone else"}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <Link to="/people" className={btn.primary}>
          Go to People
        </Link>
        <Link to="/people/import" className={btn.secondary}>
          Import another file
        </Link>
      </div>
    </div>
  );
}
