// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expireExports, finalizeDeletions } from "../lib/data-rights.server";
import { expireFeedback, notifyFeedback } from "../lib/feedback.server";
import { expireSignups } from "../lib/signup.server";
import { expireUsage } from "../lib/usage.server";
import type { Job } from "./run.server";
import { settleSupportGrants } from "./support-grants.server";

// The platform's scheduled work (hourly cron, config crons.platform), run by runJobs. The
// health check (jobs/health.server.ts) runs after these, so it can report any that failed.
export const JOBS: Job<PlatformEnv>[] = [
  // R44: camps past their 30 days are deleted for good.
  { name: "finalize_camp_deletions", run: finalizeDeletions },
  // R43: full exports are downloadable for 7 days, then removed.
  { name: "expire_exports", run: expireExports },
  // R39: expired support grants are settled and the camp's Admins told.
  { name: "settle_support_grants", run: settleSupportGrants },
  // R65: the operator hears about new feedback (a link only), and it's kept for 12 months.
  { name: "notify_feedback", run: notifyFeedback },
  { name: "expire_feedback", run: (sql) => expireFeedback(sql) },
  // R74: usage counts are kept for about 13 months.
  { name: "expire_usage", run: (sql) => expireUsage(sql) },
  // Issue #73: sign-up requests are kept for 90 days after they're decided.
  { name: "expire_signups", run: (sql) => expireSignups(sql) },
];
