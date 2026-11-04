// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Form } from "react-router";
import { useCamp } from "~/lib/camp";
import { btn, Field, input, Notice } from "./ui";

export type RsvpValues = {
  intent: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  sapRequested: boolean | null;
  sapDate: string | null;
  dwellingDescription: string | null;
  dwellingSize: string | null;
  generator: boolean | null;
};

const INTENTS = [
  { value: "going", label: "Going", hint: "I'm planning to camp with {camp}." },
  { value: "leaning_yes", label: "Leaning yes", hint: "Probably, but not certain yet." },
  { value: "leaning_no", label: "Leaning no", hint: "Probably not this year." },
  { value: "not_going", label: "Not going", hint: "Not this year." },
];

const triValue = (v: boolean | null) => (v === true ? "yes" : v === false ? "no" : "");

function TriSelect({
  name,
  value,
  label,
  hint,
}: {
  name: string;
  value: boolean | null;
  label: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <select name={name} defaultValue={triValue(value)} className={input}>
        <option value="">Not sure yet</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </Field>
  );
}

// The RSVP + logistics form for the current season. Every logistics field is optional; blank means "not sure yet".
export function RsvpForm({
  year,
  sapDays,
  values,
  error,
  submitLabel = "Save RSVP",
  showSap = true,
  sapHint,
}: {
  year: number;
  sapDays: Array<{ value: string; label: string }>;
  values: RsvpValues | null;
  error?: string;
  submitLabel?: string;
  // False when the camp has Setup Access Passes switched off. The answers are kept as they
  // were (hidden fields), not cleared.
  showSap?: boolean;
  // The camp's own wording (page text rsvp_sap_hint), already filled in.
  sapHint: string;
}) {
  const { campName } = useCamp();
  const [intent, setIntent] = useState(values?.intent ?? "");
  const showLogistics = intent !== "not_going";
  return (
    <Form method="post" className="space-y-6">
      {error && <Notice tone="error">{error}</Notice>}
      <fieldset className="space-y-2">
        <legend className="mb-2 font-semibold">{`Are you coming to the burn in ${year}?`}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {INTENTS.map((o) => ({ ...o, hint: o.hint.replace("{camp}", campName) })).map((o) => (
            <label
              key={o.value}
              className={`flex cursor-pointer gap-3 rounded-xl p-3 ring-1 ${intent === o.value ? "bg-gold-glow ring-gold" : "bg-white ring-dust-light"}`}
            >
              <input
                type="radio"
                name="intent"
                value={o.value}
                checked={intent === o.value}
                onChange={() => setIntent(o.value)}
                className="mt-1"
                required
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-sm text-charcoal">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Hidden (not removed) for Not going, so earlier answers are kept if they change back. */}
      <fieldset
        hidden={!showLogistics}
        className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light"
      >
        <legend className="px-1 font-semibold">Logistics</legend>
        <p className="text-sm text-charcoal">
          Fill in what you know; leave the rest for later. Leads use this to plan placement, power
          and early build.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Arrival date">
            <input
              type="date"
              name="arrivalDate"
              defaultValue={values?.arrivalDate ?? ""}
              className={input}
            />
          </Field>
          <Field label="Departure date">
            <input
              type="date"
              name="departureDate"
              defaultValue={values?.departureDate ?? ""}
              className={input}
            />
          </Field>
          {!showSap && (
            <>
              <input
                type="hidden"
                name="sapRequested"
                value={values?.sapRequested == null ? "" : values.sapRequested ? "yes" : "no"}
              />
              <input type="hidden" name="sapDate" value={values?.sapDate ?? ""} />
            </>
          )}
          {showSap && (
            <>
              <TriSelect
                name="sapRequested"
                value={values?.sapRequested ?? null}
                label="Request a Setup Access Pass (SAP)?"
                hint={sapHint}
              />
              <Field
                label="SAP: day you'd like to arrive"
                hint={
                  sapDays.length
                    ? "Pick a realistic day. If you're unsure, pick a later one."
                    : "The SAP days for this year haven't been announced yet."
                }
              >
                <select
                  name="sapDate"
                  defaultValue={values?.sapDate ?? ""}
                  disabled={!sapDays.length}
                  className={input}
                >
                  <option value="">Not sure yet</option>
                  {sapDays.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
        <Field label="Dwelling or vehicle" hint="e.g. 20' trailer, Shiftpod, tent + car">
          <input
            name="dwellingDescription"
            defaultValue={values?.dwellingDescription ?? ""}
            className={input}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approximate footprint" hint="e.g. 10 x 20 ft">
            <input
              name="dwellingSize"
              defaultValue={values?.dwellingSize ?? ""}
              className={input}
            />
          </Field>
          <TriSelect
            name="generator"
            value={values?.generator ?? null}
            label="Bringing a generator?"
          />
        </div>
      </fieldset>

      <button type="submit" className={btn.primary}>
        {submitLabel}
      </button>
    </Form>
  );
}
