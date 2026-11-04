// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { opsContext } from "../lib/context.server";
import { listFeedback } from "../lib/feedback.server";
import type { Route } from "./+types/ops.feedback";

// R65: feedback members sent from their camp apps, newest first. Shown as plain text (React
// escapes it; nothing is rendered as HTML or Markdown), with no member identity.
export async function loader({ context }: Route.LoaderArgs) {
  const { sql } = context.get(opsContext);
  return { feedback: await listFeedback(sql) };
}

export default function Feedback({ loaderData }: Route.ComponentProps) {
  const { feedback } = loaderData;
  return (
    <section className="space-y-5">
      <h1 className="text-xl font-bold">Feedback</h1>
      <p className="text-sm opacity-80">Kept for 12 months. The newest 200 are shown.</p>
      {feedback.length === 0 ? (
        <p className="text-sm">No feedback yet.</p>
      ) : (
        <ul className="space-y-3">
          {feedback.map((f) => (
            <li key={f.id} className="space-y-2 rounded border p-3">
              <p className="text-xs opacity-80">
                {`${f.slug} · ${f.path} · ${f.role} · ${new Date(f.createdAt).toLocaleString()}`}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{f.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
