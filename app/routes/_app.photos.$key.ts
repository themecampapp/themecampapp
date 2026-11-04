// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data } from "react-router";
import { getViewer } from "~/lib/access.server";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { keyFor } from "~/lib/files.server";
import { photoVisibleTo } from "~/lib/photos.server";
import type { Route } from "./+types/_app.photos.$key";

// Serves a Yearbook photo from the private bucket. Runs under the _app middleware (active
// member), then checks this photo specifically: its owner, a Lead, or while the owner is in
// this year's Yearbook. Anything else, including unknown keys, is a 404.
export async function loader({ params, context }: Route.LoaderArgs) {
  const notFound = () =>
    data({ reason: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const { camp, env } = context.get(cloudflareContext);
  // Only ever this camp's prefix, then only a photo this camp's database knows about.
  const key = keyFor(camp.id, "p", params.key);
  if (!key?.endsWith(".webp")) throw notFound();
  if (!(await photoVisibleTo(getDb(context), getViewer(context), key))) throw notFound();

  const obj = await env.PHOTOS.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // Keys change on every replace, so a day of per-browser caching never goes stale.
      "Cache-Control": "private, max-age=86400",
      ETag: obj.httpEtag,
    },
  });
}
