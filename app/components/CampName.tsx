// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCamp } from "~/lib/camp";

// The camp's name, as its Admins set it.
export function CampName() {
  const { campName } = useCamp();
  return <>{campName}</>;
}

// The header's mark: the camp's logo if it has one, otherwise the first letter of its name on
// the camp's accent colour (issue #67: nothing that belongs to any one camp).
export function CampMark() {
  const { campName, logoUrl } = useCamp();
  if (logoUrl) return <img src={logoUrl} alt="" className="h-7 w-auto max-w-40 object-contain" />;
  const initial = Array.from(campName.trim())[0]?.toUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      data-camp-mark
      className="inline-grid size-6 shrink-0 place-items-center rounded-md bg-gold text-[0.8125rem] leading-none font-bold text-night"
    >
      {initial}
    </span>
  );
}
