// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// In-app feedback (R65), shared by the feedback page and the server.

export const FEEDBACK_MAX = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The page feedback was sent from, with nothing that could point at a record or a person:
// only the path (no query or fragment), and any id-like segment (a UUID, a number, a long
// token, an email) replaced by ":id". Anything that isn't a path on this site becomes "/".
export function feedbackPath(raw: string | null): string {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return "/";
  const path = raw.split(/[?#]/)[0].replace(/\.data$/, "");
  const parts = path.split("/").map((seg) => {
    let s: string;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return ":id";
    }
    if (!s) return "";
    if (UUID_RE.test(s) || /\d/.test(s) || s.includes("@") || s.length > 24) return ":id";
    return /^[a-z][a-z-]*$/i.test(s) ? s.toLowerCase() : ":id";
  });
  return (
    parts
      .join("/")
      .replace(/\.data$/, "")
      .slice(0, 200) || "/"
  );
}
