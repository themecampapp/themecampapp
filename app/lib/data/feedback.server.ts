// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, sql } from "drizzle-orm";
import { data } from "react-router";
import { person } from "~/db/schema";
import type { Viewer } from "../access.server";
import type { Db } from "../db.server";
import { FEEDBACK_MAX, feedbackPath } from "../feedback";
import { sendMail } from "../mail.server";

type MailEnv = import("../mail.server").MailEnv;

const refuse = (reason: string, status = 400) => data({ reason }, { status });

// The viewer's highest role, which is all the operator learns about who sent it.
export const feedbackRole = (v: Viewer) =>
  v.roles.includes("admin")
    ? "admin"
    : v.roles.includes("treasurer")
      ? "treasurer"
      : v.roles.includes("lead")
        ? "lead"
        : "member";

// R65: stores feedback for the operator through submit_feedback() (drizzle/0020), the camp's
// only access to the feedback table, then emails the member a fixed confirmation. Nothing
// identifying the member is stored: the camp, the page without ids, the role, the time.
export async function sendFeedback(
  db: Db,
  env: MailEnv,
  viewer: Viewer,
  input: { from: string; message: string },
) {
  if (viewer.support || viewer.demo) throw refuse("feedback_not_here", 403);
  const message = input.message.replace(/\r\n?/g, "\n").trim();
  if (!message) throw refuse("feedback_message_needed");
  if (message.length > FEEDBACK_MAX) throw refuse("feedback_too_long");
  try {
    await db.execute(
      sql`select submit_feedback(${feedbackPath(input.from)}, ${feedbackRole(viewer)}, ${message})`,
    );
  } catch (e) {
    if (String((e as { cause?: unknown }).cause ?? e).includes("feedback_rate_limited")) {
      throw refuse("feedback_rate_limited", 429);
    }
    throw e;
  }
  const [me] = await db
    .select({ email: person.email })
    .from(person)
    .where(eq(person.id, viewer.personId));
  // The feedback is stored either way; a confirmation that can't go out isn't worth an error.
  if (me?.email) await sendMail(db, env, "feedback_received", me.email, { url: env.APP_URL });
}
