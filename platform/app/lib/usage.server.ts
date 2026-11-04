// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";

// R74: how each camp uses the app, from camp_usage() (drizzle/0021): numbers per camp per day
// under fixed metric names, route ids and action names. Never who did what (R38).

export type UsageRow = { campId: string; day: string; metric: string; count: number };

const HELD = new Set(["mail:skipped", "mail:suppressed", "mail:paused", "mail:capped"]);

export async function campUsage(
  sql: postgres.Sql,
  days: number,
  campId?: string,
): Promise<UsageRow[]> {
  const rows = await sql<UsageRow[]>`
    select camp_id as "campId", day::text as day, metric, count
    from camp_usage(current_date - ${days - 1}::int)
    ${campId ? sql`where camp_id = ${campId}` : sql``}`;
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

// The UTC day `n` days before `today` (YYYY-MM-DD).
export const daysAgo = (today: string, n: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);

// What the all-camps table shows: last 7 days (and 30 for views), plus active members now.
export type CampSummary = {
  active7: number;
  active30: number;
  views7: number;
  views30: number;
  signIns7: number;
  signInFailures7: number;
  actions7: number;
  errors4xx7: number;
  errors5xx7: number;
  clientErrors7: number;
  mailSent7: number;
  mailHeld7: number;
  mailFailed7: number;
};

export function summarize(rows: UsageRow[], today: string): Map<string, CampSummary> {
  const week = daysAgo(today, 6);
  const out = new Map<string, CampSummary>();
  for (const r of rows) {
    const s =
      out.get(r.campId) ??
      ({
        active7: 0,
        active30: 0,
        views7: 0,
        views30: 0,
        signIns7: 0,
        signInFailures7: 0,
        actions7: 0,
        errors4xx7: 0,
        errors5xx7: 0,
        clientErrors7: 0,
        mailSent7: 0,
        mailHeld7: 0,
        mailFailed7: 0,
      } satisfies CampSummary);
    out.set(r.campId, s);
    const inWeek = r.day >= week;
    if (r.metric === "active:7d") s.active7 = r.count;
    else if (r.metric === "active:30d") s.active30 = r.count;
    else if (r.metric.startsWith("view:")) {
      s.views30 += r.count;
      if (inWeek) s.views7 += r.count;
    } else if (!inWeek) continue;
    else if (r.metric === "auth:signed_in") s.signIns7 += r.count;
    else if (r.metric.startsWith("auth:sign_in_failed")) s.signInFailures7 += r.count;
    else if (r.metric.startsWith("action:")) s.actions7 += r.count;
    else if (r.metric.startsWith("status:4")) s.errors4xx7 += r.count;
    else if (r.metric.startsWith("status:5")) s.errors5xx7 += r.count;
    else if (r.metric.startsWith("client_error:")) s.clientErrors7 += r.count;
    else if (r.metric === "mail:sent") s.mailSent7 += r.count;
    else if (HELD.has(r.metric)) s.mailHeld7 += r.count;
    else if (r.metric === "mail:failed") s.mailFailed7 += r.count;
  }
  return out;
}

// One camp's page: a daily series for the chart, and every metric's 7- and 30-day totals,
// grouped by kind.
export type MetricTotal = { name: string; last7: number; last30: number };
export type CampDetail = {
  daily: Array<{ day: string; views: number; actions: number; problems: number }>;
  active7: number;
  active30: number;
  groups: Record<"pages" | "features" | "signIn" | "problems" | "email", MetricTotal[]>;
};

export function campDetail(rows: UsageRow[], today: string): CampDetail {
  const week = daysAgo(today, 6);
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: daysAgo(today, 29 - i),
    views: 0,
    actions: 0,
    problems: 0,
  }));
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const totals = new Map<string, MetricTotal>();
  let active7 = 0;
  let active30 = 0;
  for (const r of rows) {
    if (r.metric === "active:7d") active7 = r.count;
    if (r.metric === "active:30d") active30 = r.count;
    if (r.metric.startsWith("active:")) continue;
    const d = byDay.get(r.day);
    if (d) {
      if (r.metric.startsWith("view:")) d.views += r.count;
      else if (r.metric.startsWith("action:")) d.actions += r.count;
      else if (r.metric.startsWith("status:5") || r.metric.startsWith("client_error:"))
        d.problems += r.count;
    }
    const t = totals.get(r.metric) ?? { name: r.metric, last7: 0, last30: 0 };
    t.last30 += r.count;
    if (r.day >= week) t.last7 += r.count;
    totals.set(r.metric, t);
  }
  const pick = (test: (m: string) => boolean, strip: RegExp) =>
    [...totals.values()]
      .filter((t) => test(t.name))
      .map((t) => ({ ...t, name: t.name.replace(strip, "") }))
      .sort((a, b) => b.last30 - a.last30 || a.name.localeCompare(b.name));
  return {
    daily,
    active7,
    active30,
    groups: {
      pages: pick((m) => m.startsWith("view:"), /^view:/),
      features: pick((m) => m.startsWith("action:") || m.startsWith("join:"), /^action:/),
      signIn: pick((m) => m.startsWith("auth:"), /^auth:/),
      problems: pick((m) => m.startsWith("status:") || m.startsWith("client_error:"), /^$/),
      email: pick((m) => m.startsWith("mail:"), /^mail:/),
    },
  };
}

// Today as the database sees it (UTC), so day boundaries match camp_usage().
export async function usageToday(sql: postgres.Sql): Promise<string> {
  const [row] = await sql<{ today: string }[]>`select current_date::text as today`;
  return row.today;
}

// Hourly: usage counts older than 400 days are removed, camp by camp (usage_daily is a camp
// table, under row-level security).
export async function expireUsage(sql: postgres.Sql): Promise<number> {
  const camps = await sql<{ id: string }[]>`select id from camp`;
  let removed = 0;
  for (const c of camps) {
    const n = (await sql.begin(async (tx) => {
      await tx`select set_config('app.camp_id', ${c.id}, true)`;
      const r = await tx`delete from usage_daily where day < current_date - 400`;
      return r.count;
    })) as number;
    removed += n;
  }
  return removed;
}
