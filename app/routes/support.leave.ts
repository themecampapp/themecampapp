// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "react-router";
import { cloudflareContext } from "~/lib/context.server";
import { clearSupportCookie } from "~/lib/support.server";
import type { Route } from "./+types/support.leave";

// Leaves the support view: the cookie goes, and the operator is back at the console.
export function loader() {
  return new Response("Not found", { status: 404 });
}

export function action({ context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  throw redirect(`https://ops.${env.APP_HOST_SUFFIX}/ops`, {
    headers: { "Set-Cookie": clearSupportCookie() },
  });
}
