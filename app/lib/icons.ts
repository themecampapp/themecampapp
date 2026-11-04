// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The instance's icon (open-source plan 3.5): favicon.ico (16, 32 and 48 px) and a 180 px
// apple-touch-icon.png, from icons/<dir>/, where <dir> is the instance config's product.icon (the
// ICON_DIR var). icons/hosted is the hosted service's TCA icon; icons/default is a neutral one,
// and scripts/make-icon.ts draws a new one from initials. Every folder is bundled and the
// instance's is picked at runtime, like the legal pages; both Workers answer these two paths
// themselves, before anything else.
const files = import.meta.glob("../../icons/*/*.{ico,png}", {
  query: "?inline",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TYPES: Record<string, string> = {
  "/favicon.ico": "image/x-icon",
  "/apple-touch-icon.png": "image/png",
};

const decode = (dataUrl: string) => {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// The icon for this path, or null when the path isn't an icon's. An instance whose folder lacks
// one falls back to icons/default.
export function iconResponse(env: { ICON_DIR?: string }, pathname: string): Response | null {
  const type = TYPES[pathname];
  if (!type) return null;
  const file = pathname.slice(1);
  const data =
    files[`../../icons/${env.ICON_DIR || "default"}/${file}`] ??
    files[`../../icons/default/${file}`];
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(decode(data), {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" },
  });
}
