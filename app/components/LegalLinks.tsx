// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCamp } from "~/lib/camp";

// The Terms, Privacy Policy and data-handling page, on every page of a camp's site. They're
// the instance's (the platform's public site), not the camp's. Then the instance's source code,
// which the AGPL (section 13) has it offer to everyone who uses it.
export function LegalLinks({ className = "" }: { className?: string }) {
  const { legalBase, sourceUrl } = useCamp();
  const links: [string, string][] = legalBase
    ? [
        [`${legalBase}/legal/terms`, "Terms"],
        [`${legalBase}/legal/privacy`, "Privacy"],
        [`${legalBase}/legal/data-handling`, "How we handle data"],
      ]
    : [];
  if (sourceUrl) links.push([sourceUrl, "Source code"]);
  if (links.length === 0) return null;
  return (
    <nav aria-label="Legal" className={`flex flex-wrap gap-x-3 gap-y-1 ${className}`}>
      {links.map(([href, label]) => (
        <a
          key={label}
          href={href}
          className="underline pointer-coarse:inline-block pointer-coarse:py-2"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
