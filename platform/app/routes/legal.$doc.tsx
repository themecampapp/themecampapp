// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, Link } from "react-router";
import { LEGAL_DOCS, type LegalDoc, legalDocs, legalText } from "~/lib/legal";
import { renderMarkdown } from "~/lib/markdown.server";
import { publicContext } from "../lib/context.server";
import type { Route } from "./+types/legal.$doc";

// R49: the instance's public legal pages, from legal/<dir>/ (open-source plan 3.6: the hosted
// service's own are legal/hosted). The pilot agreement only where the instance uses one.
export function loader({ params, context }: Route.LoaderArgs) {
  const { env, contact, product, sourceUrl } = context.get(publicContext);
  const doc = params.doc as LegalDoc;
  const text = legalText(env, doc, contact);
  if (text === null) throw data(null, { status: 404 });
  return {
    title: LEGAL_DOCS[doc],
    product,
    sourceUrl,
    docs: legalDocs(env).map((d) => ({ doc: d, title: LEGAL_DOCS[d] })),
    html: renderMarkdown(text),
  };
}

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: loaderData ? `${loaderData.title} · ${loaderData.product}` : "" },
];

export default function Legal({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <Link to="/" className="text-sm underline">
        {loaderData.product}
      </Link>
      <h1 className="text-3xl font-bold">{loaderData.title}</h1>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by markdown.server.ts (raw HTML off) from content/legal */}
      <article className="legal" dangerouslySetInnerHTML={{ __html: loaderData.html }} />
      <footer className="border-t pt-4 text-sm">
        <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1">
          {loaderData.docs.map(({ doc, title }) => (
            <Link key={doc} to={`/legal/${doc}`} className="underline">
              {title}
            </Link>
          ))}
          {loaderData.sourceUrl && (
            <a href={loaderData.sourceUrl} className="underline">
              Source code
            </a>
          )}
        </nav>
      </footer>
    </main>
  );
}
