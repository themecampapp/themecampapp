// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { data, redirect } from "react-router";
import { person } from "~/db/schema";
import { getViewer, inWorkspace } from "~/lib/access.server";
import { getDb } from "~/lib/context.server";
import { isOrientationStep } from "~/lib/orientation";
import type { Route } from "./+types/_app.orientation";

// Issue #65: the Lead orientation's Pause, Stop and finish. Pause remembers the step, so the
// tour picks up there on the next visit; Stop and finishing mean it doesn't start on its own
// again (for an Admin, at the Admin level; a Lead made Admin later sees the Admin steps).
export function loader() {
  return redirect("/");
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  if (!inWorkspace(viewer)) throw data({ reason: "forbidden" }, { status: 403 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const step = String(form.get("step") ?? "");
  const db = getDb(context);
  if (intent === "pause") {
    if (!isOrientationStep(step)) throw data({ reason: "bad_step" }, { status: 400 });
    await db.update(person).set({ orientationStep: step }).where(eq(person.id, viewer.personId));
  } else if (intent === "stop" || intent === "finish") {
    await db
      .update(person)
      .set({ orientationDone: viewer.isAdmin ? "admin" : "lead", orientationStep: null })
      .where(eq(person.id, viewer.personId));
  } else {
    throw data({ reason: "bad_intent" }, { status: 400 });
  }
  return { ok: true };
}
