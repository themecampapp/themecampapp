// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { type Finding, raiseAlerts } from "../lib/alerts.server";
import { isolationProblems } from "../lib/isolation.server";

// R55: the hourly health check. It looks at every camp and the database, and emails the
// operator about what's wrong (once a day while it stays wrong: lib/alerts.server.ts).
// Worker errors (5xx) aren't counted here: they're in Workers Logs (docs/operating.md, Alerts).

// Of the emails a camp tried to send in the last hour, the share the email provider refused.
export const SEND_FAILURE_RATE = 0.2;
export const MIN_SEND_ATTEMPTS = 10;
// Failed sign-ins (a bad or expired link, or the sign-in email failing to send) in one camp in
// the last hour. A camp's normal hour has a handful at most.
export const SIGN_IN_FAILURES = 10;

export async function healthFindings(sql: postgres.Sql, domain: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const camps = await sql<{ id: string; slug: string; sending_paused: boolean }[]>`
    select id, slug, sending_paused from camp where status <> 'pending_deletion' order by slug`;
  for (const c of camps) {
    const site = `${c.slug}.${domain}`;
    if (c.sending_paused) {
      findings.push({
        key: `paused:${c.slug}`,
        subject: `Email paused for ${c.slug}`,
        text: `Email from ${site} is still paused. Clear camp.sending_paused once it's sorted out.`,
      });
    }
    const [h] = (await sql.begin(async (tx) => {
      await tx`select set_config('app.camp_id', ${c.id}, true)`;
      return tx<{ attempts: number; failed: number; sign_in_failures: number }[]>`
        select
          (select count(*) from send_log where created_at > now() - interval '1 hour'
             and status in ('sent', 'failed'))::int as attempts,
          (select count(*) from send_log where created_at > now() - interval '1 hour'
             and status = 'failed')::int as failed,
          (select count(*) from auth_event where created_at > now() - interval '1 hour'
             and event in ('sign_in_failed', 'link_send_failed'))::int as sign_in_failures`;
    })) as { attempts: number; failed: number; sign_in_failures: number }[];
    if (h.attempts >= MIN_SEND_ATTEMPTS && h.failed / h.attempts > SEND_FAILURE_RATE) {
      findings.push({
        key: `send_failures:${c.slug}`,
        subject: `Email failing for ${c.slug}`,
        text: `In the last hour ${h.failed} of ${h.attempts} emails from ${site} failed to send (over ${SEND_FAILURE_RATE * 100}%). Check the email provider, then send_log's errors.`,
      });
    }
    if (h.sign_in_failures >= SIGN_IN_FAILURES) {
      findings.push({
        key: `sign_in_failures:${c.slug}`,
        subject: `Sign-in failures at ${c.slug}`,
        text: `In the last hour ${h.sign_in_failures} sign-ins failed at ${site} (the alert is at ${SIGN_IN_FAILURES}). Its Admin → Sign-in log shows the steps.`,
      });
    }
  }
  // Row-level security, checked for real as this Worker's role (with a real camp, if any).
  const problems = await isolationProblems(sql, camps[0]?.id);
  if (problems.length) {
    findings.push({
      key: "isolation",
      subject: "Camp isolation problem",
      text: [
        "The isolation probe found rows one camp could see that it shouldn't. Treat this as an incident (docs/operating.md, Incidents).",
        "",
        ...problems.map((p) => `- ${p}`),
      ].join("\n"),
    });
  }
  return findings;
}

// The job: everything wrong now, plus any job that failed this run.
export async function checkHealth(
  sql: postgres.Sql,
  env: PlatformEnv,
  failedJobs: Array<{ name: string; error?: string }> = [],
): Promise<string[]> {
  const findings = await healthFindings(sql, env.PLATFORM_DOMAIN);
  for (const j of failedJobs) {
    findings.push({
      key: `job:${j.name}`,
      subject: `Scheduled job ${j.name} failed`,
      text: `The hourly job ${j.name} failed: ${j.error ?? "unknown error"}. It runs again next hour; Workers Logs for tca-platform has the details.`,
    });
  }
  return raiseAlerts(sql, env, findings, { settle: true });
}
