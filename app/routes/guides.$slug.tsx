// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link, redirect } from "react-router";
import { PublicShell } from "~/components/PublicShell";
import { Notice } from "~/components/ui";
import { inWorkspace, resolveViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { defer, getDb, getWriteDb } from "~/lib/context.server";
import { canRead, findGuide, listGuides, renderGuide } from "~/lib/data/guides.server";
import { logSupportView } from "~/lib/support.server";
import type { Route } from "./+types/guides.$slug";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, `${loaderData?.guide.title ?? "Guide"}`) }];
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const slug = params.slug;
  const db = getDb(context);
  const found = SLUG_RE.test(slug) ? await findGuide(db, slug) : null;
  const visibility = found?.visibility ?? null;
  const viewer = await resolveViewer(request, context, { link: false });
  // R40: guide pages support opens are in the camp's Activity too (they're outside _app).
  if (viewer.status === "member" && viewer.viewer.support) {
    defer(
      context,
      logSupportView(getWriteDb(context), viewer.viewer.support, new URL(request.url).pathname),
    );
  }
  const signedIn = viewer.status !== "anonymous";
  const access = {
    member: viewer.status === "member",
    lead: viewer.status === "member" && inWorkspace(viewer.viewer),
  };

  // Members-only, Leads-only or unknown. Signed-out visitors are sent to sign-in either way,
  // and anyone who can't read it gets the same 404 as an unknown guide, so the response never
  // reveals which private guides exist.
  if (visibility !== "public") {
    if (!signedIn) throw redirect("/sign-in");
    if (!visibility || !canRead(visibility, access)) {
      throw data(
        { reason: "not_found" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  }

  const g = found as NonNullable<typeof found>;
  const guide = {
    slug: g.slug,
    title: g.title,
    summary: g.summary,
    visibility: g.visibility,
    html: renderGuide(g.body),
  };
  // The sidebar lists what this visitor can read, so a signed-in view (which may list private
  // titles) is never stored by a shared cache; only the signed-out public view is.
  const guides = (await listGuides(db, access)).map((g) => ({
    slug: g.slug,
    title: g.title,
    visibility: g.visibility,
  }));
  const shared = visibility === "public" && !signedIn;
  return data(
    {
      guide,
      guides,
      signedIn,
      joined: new URL(request.url).searchParams.get("joined") === "1",
    },
    {
      headers: shared
        ? { "X-Robots-Tag": "all", "Cache-Control": "public, max-age=300", Vary: "Cookie" }
        : visibility === "public"
          ? { "X-Robots-Tag": "all", "Cache-Control": "private, no-store" }
          : { "Cache-Control": "private, no-store" },
    },
  );
}

function GuideList({
  guides,
  current,
  showJoin,
}: {
  guides: Array<{ slug: string; title: string; visibility: string }>;
  current: string;
  showJoin: boolean;
}) {
  return (
    <nav id="more-guides" aria-label="Guides" className="space-y-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-charcoal">
          Camp guides
        </h2>
        <ul className="space-y-1">
          {guides.map((g) => (
            <li key={g.slug}>
              <Link
                to={`/guides/${g.slug}`}
                aria-current={g.slug === current ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-sm ${
                  g.slug === current
                    ? "bg-night font-semibold text-warm-white"
                    : "hover:bg-dust-pale"
                }`}
              >
                {g.title}
                {g.visibility !== "public" && (
                  <span className="ml-1 text-xs opacity-70">
                    {g.visibility === "leads" ? "· Leads" : "· Members"}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {showJoin && (
        <div className="rounded-xl bg-gold-glow p-3 text-sm ring-1 ring-gold">
          <div className="font-semibold">Thinking of joining us?</div>
          <p className="mt-1 text-charcoal">
            Tell us a little about yourself and a lead will reach out.
          </p>
          <Link to="/join" className="mt-2 inline-block font-semibold underline">
            Get in touch
          </Link>
        </div>
      )}
    </nav>
  );
}

export default function Guide({ loaderData, params }: Route.ComponentProps) {
  const { guide, guides, signedIn, joined } = loaderData;
  return (
    <PublicShell signedIn={signedIn} wide>
      {joined && (
        <div className="mb-5">
          <Notice tone="ok">
            Thanks for reaching out! We've got your note, and a camp lead will get in touch soon.
            Check your email for a confirmation (and your spam folder, just in case). While you
            wait, have a look around: these guides explain how camp works.
          </Notice>
        </div>
      )}
      {/* Phones: the guide first, then the list (with a jump link). Wider: list on the left. */}
      <a href="#more-guides" className="mb-3 inline-block text-sm underline md:hidden">
        {`Browse all ${guides.length} guides ↓`}
      </a>
      <div className="flex flex-col gap-8 md:grid md:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="order-last md:order-first">
          <GuideList guides={guides} current={params.slug} showJoin={!signedIn && !joined} />
        </aside>
        <article className="guide min-w-0">
          <h1 className="mb-1 text-2xl font-bold">{guide.title}</h1>
          {guide.summary && <p className="mb-5 text-charcoal">{guide.summary}</p>}
          {/* Rendered on the server by app/lib/markdown.server.ts: raw HTML shown as text, links
              only to this site or https. */}
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by markdown.server.ts */}
          <div dangerouslySetInnerHTML={{ __html: guide.html }} />
        </article>
      </div>
    </PublicShell>
  );
}

export function ErrorBoundary() {
  return (
    <PublicShell signedIn={false}>
      <h1 className="text-2xl font-bold">Guide not found</h1>
      <Link to="/guides" className="mt-3 inline-block underline">
        See all guides
      </Link>
    </PublicShell>
  );
}
