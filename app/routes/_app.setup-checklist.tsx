// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "react-router";
import { getViewer } from "~/lib/access.server";
import { getDb } from "~/lib/context.server";
import { setChecklistDismissed, setCommunityJoined } from "~/lib/data/checklist.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.setup-checklist";

// R24: hide the setup checklist (Leads and Admins, from the home page), or bring it back
// (Admins, from the Admin page). Issue #82: note that the Discord link was opened (sent in the
// background as the link opens in a new tab).
export function loader() {
  return redirect("/");
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const reopen = form.get("intent") === "reopen";
  try {
    if (form.get("intent") === "community") {
      await setCommunityJoined(getDb(context), getViewer(context));
      return { ok: true };
    }
    await setChecklistDismissed(getDb(context), getViewer(context), !reopen);
  } catch (e) {
    return formError(e);
  }
  return redirect("/");
}
