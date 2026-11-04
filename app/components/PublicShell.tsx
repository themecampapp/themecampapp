// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { Link } from "react-router";
import { CampMark, CampName } from "./CampName";

// Header for pages visible without signing in (guides). `wide` fits a guide plus its sidebar.
export function PublicShell({
  signedIn,
  wide = false,
  children,
}: {
  signedIn: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const width = wide ? "max-w-5xl" : "max-w-3xl";
  return (
    <div className="flex-1">
      <header className="border-b border-dust-light bg-white">
        <div className={`mx-auto flex ${width} items-center justify-between gap-4 px-4 py-3`}>
          <Link to={signedIn ? "/" : "/guides"} className="flex items-center gap-2 font-semibold">
            <CampMark />
            <CampName />
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link to="/guides" className="underline-offset-4 hover:underline">
              Guides
            </Link>
            {signedIn ? (
              <Link to="/" className="underline-offset-4 hover:underline">
                Home
              </Link>
            ) : (
              <Link to="/sign-in" className="underline-offset-4 hover:underline">
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className={`mx-auto ${width} px-4 py-6`}>{children}</main>
    </div>
  );
}
