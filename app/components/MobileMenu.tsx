// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";

// The signed-in header's links on phones (issue #62): a Menu button that opens a full-width
// list of big rows, in groups. A native <details>, so it works before the page's scripts load;
// it closes itself after each navigation. Wider screens show the links in the header instead.

// tour: the orientation step that points at this link (app/lib/orientation.ts).
export type NavItem = { to: string; label: string; end?: boolean; tour?: string };
export type NavGroup = { title: string; items: NavItem[] };

export function MobileMenu({ groups, footer }: { groups: NavGroup[]; footer: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on every navigation
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [location.key]);
  return (
    <details ref={menu} data-mobile-menu className="group md:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 font-medium ring-1 ring-dust [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-lg leading-none">
          <span className="group-open:hidden">☰</span>
          <span className="hidden group-open:inline">✕</span>
        </span>
        Menu
      </summary>
      <nav
        aria-label="Menu"
        className="absolute inset-x-0 z-40 mt-3 max-h-[calc(100dvh-4rem)] overflow-y-auto border-y border-dust-light bg-white px-4 pb-4 shadow-lg"
      >
        {groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.title} className="pt-3">
              <p className="px-3 pb-1 text-xs font-semibold tracking-wide text-charcoal uppercase">
                {g.title}
              </p>
              <ul>
                {g.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      data-tour={item.tour}
                      className={({ isActive }) =>
                        `flex min-h-11 items-center rounded-lg px-3 text-base ${isActive ? "bg-dust-pale font-semibold" : "hover:bg-dust-pale"}`
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        {footer && <div className="mt-3 border-t border-dust-light pt-3">{footer}</div>}
      </nav>
    </details>
  );
}
