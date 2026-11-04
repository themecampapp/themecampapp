// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAILING_FIELDS, type MailingAddress } from "~/lib/mailing-address";
import { Field, input } from "./ui";

// Issue #78: the mailing address inputs, on the profile and a Lead's edit form. Read back with
// readMailingAddress (app/lib/mailing-address.ts).
export function MailingAddressFields({ value }: { value: MailingAddress | null }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {MAILING_FIELDS.map((f) => (
        <div key={f.key} className={f.key === "line1" || f.key === "line2" ? "sm:col-span-2" : ""}>
          <Field label={f.label}>
            <input
              name={`mailing_${f.key}`}
              defaultValue={value?.[f.key] ?? ""}
              maxLength={f.max}
              autoComplete={f.autoComplete}
              className={input}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}
