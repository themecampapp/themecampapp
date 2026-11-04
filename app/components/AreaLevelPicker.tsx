// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import type { Features } from "~/lib/features";
import { type Access, AREAS, accessSummary, type Level } from "~/lib/permissions";

const LEVEL_LABEL: Record<Level, string> = { none: "No access", view: "View", manage: "Manage" };

// Issue #93: what a role can do, one row per area, each a choice of levels (no checkboxes).
// Plain radio buttons underneath, so it works before the page's script loads; the summary and
// each row's help follow the choices once it has. Areas whose feature is off aren't shown, but
// keep their level (posted as hidden fields), so switching the feature back on brings it back.
export function AreaLevelPicker({
  initial,
  features,
  disabled = false,
}: {
  initial: Access;
  features: Features;
  disabled?: boolean;
}) {
  const [access, setAccess] = useState(initial);
  const on = (feature?: keyof Features) => !feature || features[feature];
  return (
    <div className="space-y-5">
      {AREAS.filter((a) => !on(a.feature)).map((a) => (
        <input key={a.key} type="hidden" name={`level_${a.key}`} value={access[a.key]} />
      ))}
      {AREAS.filter((a) => on(a.feature)).map((a) => {
        const level = access[a.key];
        return (
          <fieldset key={a.key} className="space-y-1.5">
            <legend className="font-medium">{a.label}</legend>
            <p className="text-sm text-charcoal">{a.description}</p>
            <div
              className={`grid w-full max-w-sm overflow-hidden rounded-lg ring-1 ring-dust ${a.levels.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}
            >
              {a.levels.map((l) => (
                <label key={l} className="relative border-dust not-first:border-l">
                  <input
                    type="radio"
                    name={`level_${a.key}`}
                    value={l}
                    checked={level === l}
                    disabled={disabled}
                    onChange={() => setAccess({ ...access, [a.key]: l })}
                    className="peer sr-only"
                  />
                  <span className="flex min-h-11 cursor-pointer items-center justify-center bg-white px-2 text-sm peer-checked:bg-night peer-checked:font-semibold peer-checked:text-warm-white peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-4 peer-focus-visible:outline-gold peer-disabled:cursor-default">
                    {LEVEL_LABEL[l]}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-charcoal">
              {level === "none" ? "No access to this area." : a.levelHelp[level]}
            </p>
          </fieldset>
        );
      })}
      <p className="rounded-lg bg-dust-pale p-3 text-sm" aria-live="polite">
        {accessSummary(access, features)}
      </p>
    </div>
  );
}
