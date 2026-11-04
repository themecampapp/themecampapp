// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link } from "react-router";
import { PublicShell } from "~/components/PublicShell";
import { inWorkspace, resolveViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { defer, getDb, getWriteDb } from "~/lib/context.server";
import { listGuides } from "~/lib/data/guides.server";
import { logSupportView } from "~/lib/support.server";
import type { Route } from "./+types/guides._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Guides") }];
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

// Public guides for everyone; members-only guides for active members; Leads-only for Leads.
export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await resolveViewer(request, context, { link: false });
  // R40: guide pages support opens are in the camp's Activity too (they're outside _app).
  if (viewer.status === "member" && viewer.viewer.support) {
    defer(
      context,
      logSupportView(getWriteDb(context), viewer.viewer.support, new URL(request.url).pathname),
    );
  }
  const member = viewer.status === "member";
  const lead = viewer.status === "member" && inWorkspace(viewer.viewer);
  const guides = await listGuides(getDb(context), { member, lead });
  return data(
    { guides, member, lead, signedIn: viewer.status !== "anonymous" },
    { headers: member ? { "Cache-Control": "private, no-store" } : { "X-Robots-Tag": "all" } },
  );
}

export default function Guides({ loaderData }: Route.ComponentProps) {
  const { guides, member, lead, signedIn } = loaderData;
  return (
    <PublicShell signedIn={signedIn}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Camp guides</h1>
        {lead && (
          <Link to="/guide-editor" className="text-sm font-semibold underline">
            Edit guides
          </Link>
        )}
      </div>
      {guides.length === 0 && (
        <p className="text-charcoal">
          {lead ? "No guides are published yet. Write one in the guide editor." : "No guides yet."}
        </p>
      )}
      <ul className="space-y-2">
        {guides.map((g) => (
          <li key={g.slug}>
            <Link
              to={`/guides/${g.slug}`}
              className="block rounded-xl bg-white p-4 ring-1 ring-dust-light hover:ring-night"
            >
              <span className="font-semibold">{g.title}</span>
              {g.visibility !== "public" && (
                <span className="ml-2 rounded-full bg-dust-pale px-2 py-0.5 text-xs ring-1 ring-dust">
                  {g.visibility === "leads" ? "Leads" : "Members"}
                </span>
              )}
              {g.summary && <span className="block text-sm text-charcoal">{g.summary}</span>}
            </Link>
          </li>
        ))}
      </ul>
      {!member && (
        <p className="mt-6 text-sm text-charcoal">
          Camp members can{" "}
          <Link to="/sign-in" className="font-semibold underline">
            sign in
          </Link>{" "}
          for more guides.
        </p>
      )}
    </PublicShell>
  );
}
