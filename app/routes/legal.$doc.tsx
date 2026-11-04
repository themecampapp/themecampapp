// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link } from "react-router";
import { PublicShell } from "~/components/PublicShell";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext } from "~/lib/context.server";
import { singleCamp } from "~/lib/hosts";
import { LEGAL_DOCS, type LegalDoc, legalDocs, legalText } from "~/lib/legal";
import { renderMarkdown } from "~/lib/markdown.server";
import type { Route } from "./+types/legal.$doc";

// The instance's legal pages on a single-camp instance (open-source plan 3.4), which has no
// public site: the same documents the platform Worker serves at the apex elsewhere
// (platform/app/routes/legal.$doc.tsx). On a multi-camp instance, a camp's host has none.
export function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  if (!singleCamp(env)) throw data(null, { status: 404 });
  const doc = params.doc as LegalDoc;
  const text = legalText(env, doc);
  if (text === null) throw data(null, { status: 404 });
  return {
    title: LEGAL_DOCS[doc],
    docs: legalDocs(env).map((d) => ({ doc: d, title: LEGAL_DOCS[d] })),
    html: renderMarkdown(text),
  };
}

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, loaderData?.title ?? "") }];
}

export default function Legal({ loaderData }: Route.ComponentProps) {
  return (
    <PublicShell signedIn={false}>
      <h1 className="text-2xl font-bold">{loaderData.title}</h1>
      <article className="guide mt-4 rounded-xl bg-white p-5 ring-1 ring-dust-light">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by markdown.server.ts (raw HTML off) from legal/ */}
        <div dangerouslySetInnerHTML={{ __html: loaderData.html }} />
      </article>
      <nav aria-label="Legal" className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {loaderData.docs.map(({ doc, title }) => (
          <Link key={doc} to={`/legal/${doc}`} className="underline">
            {title}
          </Link>
        ))}
      </nav>
    </PublicShell>
  );
}
