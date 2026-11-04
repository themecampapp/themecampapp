// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";

export type CardView = {
  key: string;
  url: string;
  label: string;
  secondary: string | null;
  homeLocation?: string | null;
  years: number[];
};

// A photo's URL: its file name, served by /photos/<name> for this camp only.
export const photoUrl = (key: string) => `/photos/${key.slice(key.lastIndexOf("/") + 1)}`;
export const yearsText = (years: number[]) => years.join(" · ");

// Current season first, then past seasons newest first. The current one lives at /yearbook.
export function YearSwitcher({
  current,
  past,
  selected,
}: {
  current: number;
  past: number[];
  selected: number;
}) {
  if (!past.length) return null;
  return (
    <nav className="mb-5 flex flex-wrap gap-2 text-sm" aria-label="Yearbook year">
      {[current, ...past].map((y) => (
        <Link
          key={y}
          to={y === current ? "/yearbook" : `/yearbook/${y}`}
          aria-current={y === selected ? "page" : undefined}
          className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${y === selected ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
        >
          {y}
        </Link>
      ))}
    </nav>
  );
}

export function CardGrid({ cards }: { cards: CardView[] }) {
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {cards.map((c) => (
        <li key={c.key} className="text-center">
          <img
            src={c.url}
            alt={c.label}
            loading="lazy"
            className="aspect-square w-full rounded-xl object-cover ring-1 ring-dust-light"
          />
          <div className="mt-2 font-semibold">{c.label}</div>
          {c.secondary && <div className="text-sm text-charcoal">{c.secondary}</div>}
          {c.homeLocation && <div className="text-xs text-charcoal">{c.homeLocation}</div>}
          {c.years.length > 0 && (
            <div className="text-xs text-charcoal">{`Camped ${yearsText(c.years)}`}</div>
          )}
        </li>
      ))}
    </ul>
  );
}
