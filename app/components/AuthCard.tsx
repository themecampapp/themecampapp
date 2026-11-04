// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { useCamp } from "~/lib/camp";
import { CampMark } from "./CampName";

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const { campName } = useCamp();
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-dust-light">
        <div className="mb-5 flex items-center gap-3">
          <CampMark />
          <span className="font-semibold">{campName}</span>
        </div>
        <h1 className="mb-3 text-xl font-bold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export const buttonClass =
  "w-full rounded-lg bg-gold px-4 py-2.5 font-semibold text-night hover:bg-gold-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night";

export const inputClass =
  "w-full rounded-lg border border-dust bg-warm-white px-3 py-2.5 text-night focus:border-night focus:outline-none";
