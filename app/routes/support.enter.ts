// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "react-router";
import { getWriteDb } from "~/lib/context.server";
import { enterSupport, supportCookie } from "~/lib/support.server";
import type { Route } from "./+types/support.enter";

// Where the operator console sends a support token (by POST, from ops.<domain> only; the
// Worker checks the Origin). A valid token for a running grant of this camp becomes a
// read-only support session; anything else is refused without saying why.
export function loader() {
  return new Response("Not found", { status: 404 });
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  // Writable even for a suspended camp, like signing in.
  const entered = await enterSupport(getWriteDb(context), String(form.get("token") ?? ""));
  if (!entered) {
    return new Response(
      "That support link has expired or was already used. Open the camp again from the operator console.",
      {
        status: 403,
        headers: { "Content-Type": "text/plain", "Referrer-Policy": "no-referrer" },
      },
    );
  }
  const seconds = (entered.expiresAt.getTime() - Date.now()) / 1000;
  throw redirect("/", {
    headers: {
      "Set-Cookie": supportCookie(entered.session, seconds),
      "Referrer-Policy": "no-referrer",
    },
  });
}
