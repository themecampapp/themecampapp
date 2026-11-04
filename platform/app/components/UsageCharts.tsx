// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// R74: small, dependency-free charts for the console's usage numbers.

export function DailyBars({
  days,
  label,
}: {
  days: Array<{ day: string; value: number }>;
  label: string;
}) {
  const max = Math.max(1, ...days.map((d) => d.value));
  const total = days.reduce((n, d) => n + d.value, 0);
  return (
    <figure className="space-y-1">
      <figcaption className="text-xs opacity-80">{`${label}: ${total} in 30 days`}</figcaption>
      <div className="flex h-16 items-end gap-px" role="img" aria-label={`${label} per day`}>
        {days.map((d) => (
          <div
            key={d.day}
            title={`${d.day}: ${d.value}`}
            className="flex-1 bg-black/70"
            style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value ? 2 : 0 }}
          />
        ))}
      </div>
    </figure>
  );
}

export function MetricTable({
  title,
  rows,
  empty = "Nothing yet.",
}: {
  title: string;
  rows: Array<{ name: string; last7: number; last30: number }>;
  empty?: string;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs opacity-70">{empty}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b">
              <th className="py-1 pr-3 font-normal opacity-70" />
              <th className="w-16 pr-3 text-right font-normal opacity-70">7 days</th>
              <th className="w-16 text-right font-normal opacity-70">30 days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-black/5">
                <td className="break-all py-1 pr-3 font-mono">{r.name}</td>
                <td className="pr-3 text-right">{r.last7}</td>
                <td className="text-right">{r.last30}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
