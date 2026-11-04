// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

export const btn = {
  primary:
    "inline-flex cursor-pointer items-center justify-center rounded-lg transition duration-100 active:translate-y-px active:brightness-90 disabled:cursor-not-allowed bg-gold px-4 py-2 font-semibold text-night hover:bg-gold-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night disabled:opacity-50",
  secondary:
    "inline-flex cursor-pointer items-center justify-center rounded-lg transition duration-100 active:translate-y-px active:brightness-90 disabled:cursor-not-allowed border border-dust bg-white px-4 py-2 font-semibold text-night hover:bg-dust-pale focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night disabled:opacity-50",
  danger:
    "inline-flex cursor-pointer items-center justify-center rounded-lg transition duration-100 active:translate-y-px active:brightness-90 disabled:cursor-not-allowed border border-coral px-4 py-2 font-semibold text-coral-ink hover:bg-coral/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night disabled:opacity-50",
};

export const input =
  "w-full rounded-lg border border-dust bg-warm-white px-3 py-2 text-night focus:border-night focus:outline-none disabled:bg-dust-light disabled:text-charcoal";

// A file picker whose "Choose file" part looks like the app's secondary buttons (issue #88):
// the base styles strip the browser's own button look, which left plain text.
export const fileInput =
  "block max-w-full text-sm text-charcoal file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-dust file:bg-white file:px-4 file:py-2 file:font-semibold file:text-night hover:file:bg-dust-pale focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night pointer-coarse:file:py-2.5";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-charcoal">{hint}</span>}
    </label>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "ok";
  children: ReactNode;
}) {
  const tones = {
    info: "bg-dust-pale ring-dust-light",
    error: "bg-coral/10 ring-coral/40",
    ok: "bg-gold-glow ring-gold",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg p-3 text-sm ring-1 ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  not_invited: "Not invited",
  invited: "Invited",
  signed_in: "Signed in",
  rsvpd: "RSVP'd",
  rsvpd_by_lead: "RSVP'd (by Lead)",
};

export const INTENT_LABEL: Record<string, string> = {
  going: "Going",
  leaning_yes: "Leaning yes",
  leaning_no: "Leaning no",
  not_going: "Not going",
};

export const INQUIRY_LABEL: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  met: "Met",
  invited: "Invited",
  declined: "Declined",
};
