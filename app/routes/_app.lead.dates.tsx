// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, redirect, useSearchParams } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import {
  actionHidden,
  addKeyDate,
  editKeyDate,
  removeKeyDate,
  seasonDates,
} from "~/lib/data/key-dates.server";
import { currentYear } from "~/lib/data/participation.server";
import { formError } from "~/lib/errors";
import { ACTION_LABEL, type KeyDateAction, REMIND_DAYS_BEFORE } from "~/lib/key-dates";
import type { Route } from "./+types/_app.lead.dates";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Key dates") }];
}

// This season's key dates (R63). They show on members' home pages from today on.
export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const { features } = await getSettings(context);
  return {
    year: await currentYear(db),
    dates: (await seasonDates(db)).map((d) => ({ ...d, hidden: actionHidden(d.action, features) })),
    actions: (Object.keys(ACTION_LABEL) as KeyDateAction[]).filter(
      (a) => !actionHidden(a, features),
    ),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) => redirect(`/dates?notice=${encodeURIComponent(msg)}`);
  const values = {
    label: get("label"),
    date: get("date"),
    action: get("action"),
    remind: form.get("remind") === "on",
  };
  try {
    switch (get("intent")) {
      case "add":
        await addKeyDate(db, viewer, values);
        return done("Date added.");
      case "edit":
        await editKeyDate(db, viewer, get("id"), values);
        return done("Date updated.");
      case "remove":
        await removeKeyDate(db, viewer, get("id"));
        return done("Date removed.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

function Fields({
  label = "",
  date = "",
  action = "",
  remind = false,
  actions,
}: {
  label?: string;
  date?: string;
  action?: string;
  remind?: boolean;
  actions: KeyDateAction[];
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label="What">
          <input name="label" defaultValue={label} required maxLength={80} className={input} />
        </Field>
        <Field label="Date">
          <input type="date" name="date" defaultValue={date} required className={`${input} w-44`} />
        </Field>
        <Field label="Tied to">
          <select name="action" defaultValue={action} className={input}>
            <option value="">Nothing</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
            {/* A tie to a switched-off feature stays as it is when the date is edited. */}
            {action && !actions.includes(action as KeyDateAction) && (
              <option
                value={action}
              >{`${ACTION_LABEL[action as KeyDateAction]} (switched off)`}</option>
            )}
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="remind" defaultChecked={remind} />
        {`Email a reminder ${REMIND_DAYS_BEFORE} days before to those who haven't done it yet (only for a date tied to something)`}
      </label>
    </>
  );
}

const day = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

export default function KeyDates({ loaderData, actionData }: Route.ComponentProps) {
  const { year, dates, actions } = loaderData;
  const [params] = useSearchParams();
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title={`${year} key dates`} />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      <p className="text-sm text-charcoal">
        Upcoming dates show on everyone's home page. Tying a date to ticket requests reminds Leads
        to lock requests once it passes; the app never locks them itself. A date tied to something
        members do can also email a reminder, once, to whoever hasn't done it yet.
      </p>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Add a date</h2>
        <input type="hidden" name="intent" value="add" />
        <Fields actions={actions} />
        <button type="submit" className={btn.primary}>
          Add
        </button>
      </Form>

      {dates.length === 0 ? (
        <p className="text-sm text-charcoal">{`No dates for ${year} yet.`}</p>
      ) : (
        <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
          {dates.map((d) => (
            <li key={d.id} className="space-y-2 p-3">
              <p>
                <span className="font-semibold">{day(d.date)}</span>
                {` · ${d.label}`}
                {d.action && (
                  <span className="text-sm text-charcoal">{` · ${ACTION_LABEL[d.action]}`}</span>
                )}
                {d.action && d.remind && (
                  <span className="ml-2 text-xs text-charcoal">
                    {d.remindedAt ? "· Reminder sent" : "· Reminder on"}
                  </span>
                )}
                {d.hidden && (
                  <span className="ml-2 text-xs text-charcoal">
                    (hidden: dues are switched off)
                  </span>
                )}
              </p>
              <details>
                <summary className="cursor-pointer text-sm underline">Edit or remove</summary>
                <Form method="post" className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={d.id} />
                  <Fields
                    label={d.label}
                    date={d.date}
                    action={d.action ?? ""}
                    remind={d.remind}
                    actions={actions}
                  />
                  <div className="flex gap-2">
                    <button type="submit" name="intent" value="edit" className={btn.primary}>
                      Save
                    </button>
                    <button
                      type="submit"
                      name="intent"
                      value="remove"
                      formNoValidate
                      className={btn.secondary}
                    >
                      Remove
                    </button>
                  </div>
                </Form>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
