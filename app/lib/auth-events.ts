// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Each step of signing in, so Admins can see where someone got stuck (/admin/logs).
export const AUTH_EVENTS = {
  link_requested: "Asked for a sign-in link",
  link_sent: "Sign-in link emailed",
  link_not_sent: "No link sent: email isn't invited",
  link_send_failed: "Sign-in email failed to send",
  link_opened: "Opened the emailed link",
  signed_in: "Signed in",
  sign_in_failed: "Sign-in failed",
  account_linked: "First sign-in linked to their camp record",
  not_linked: "Signed in, but no camp record to link",
  signed_out: "Signed out",
} as const;
export type AuthEventName = keyof typeof AUTH_EVENTS;

// A short "iPhone · Safari" style label for a user agent, so the log is readable.
export function deviceLabel(ua: string | null): string {
  if (!ua) return "";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /GSA\/|Gmail/.test(ua)
      ? "Google app"
      : /FBAN|FBAV|Instagram/.test(ua)
        ? "in-app browser"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "";
  const label = [os, browser].filter(Boolean).join(" · ");
  return label || ua.slice(0, 40);
}
