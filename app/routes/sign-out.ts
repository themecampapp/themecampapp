// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "react-router";
import { logAuthEvent } from "~/lib/auth-log.server";
import { getAuth, getWriteDb } from "~/lib/context.server";
import type { Route } from "./+types/sign-out";

export async function action({ request, context }: Route.ActionArgs) {
  const session = await getAuth(context).api.getSession({ headers: request.headers });
  if (session) {
    await logAuthEvent(getWriteDb(context), {
      event: "signed_out",
      email: session.user.email,
      request,
    });
  }
  const res = await getAuth(context).api.signOut({ headers: request.headers, asResponse: true });
  const out = redirect("/sign-in");
  for (const cookie of res.headers.getSetCookie()) out.headers.append("Set-Cookie", cookie);
  return out;
}

export function loader() {
  return redirect("/");
}
