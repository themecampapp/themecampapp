// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data } from "react-router";
import { cloudflareContext, getSettings } from "~/lib/context.server";
import { keyFor } from "~/lib/files.server";
import type { Route } from "./+types/logo.$name";

// The camp's logo, for anyone who can see the camp's pages (the sign-in page shows it too).
// Only the logo this camp has set is served: the name must be its current logo's, under its
// own prefix. The key changes whenever the logo does, so browsers may keep it for a day.
export async function loader({ params, context }: Route.LoaderArgs) {
  const notFound = () =>
    data({ reason: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const { camp, env } = context.get(cloudflareContext);
  const key = keyFor(camp.id, "logo", params.name);
  if (!key?.endsWith(".webp") || key !== (await getSettings(context)).logoKey) throw notFound();
  const obj = await env.PHOTOS.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=86400",
      ETag: obj.httpEtag,
    },
  });
}
