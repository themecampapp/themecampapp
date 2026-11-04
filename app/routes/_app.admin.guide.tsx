// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { PageHeader } from "~/components/ui";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext } from "~/lib/context.server";
import { legalBase } from "~/lib/hosts";
import { pilotAgreementOn } from "~/lib/legal";
import { renderMarkdown } from "~/lib/markdown.server";
import { APP_VERSION } from "~/lib/version";
import guideText from "../../content/admin-guide.md?raw";
import type { Route } from "./+types/_app.admin.guide";

// The Admin guide: how the Admin pages work. The app's own (content/admin-guide.md), the same
// for every camp and kept up to date with it, unlike the guides each camp writes. Admins only,
// via the admin layout.
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Admin guide") }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // The instance's own links (open-source plan 2.4). Without a support community, help is the
  // contact address.
  // Without a pilot agreement (open-source plan 3.6), its bullet goes.
  const guide = pilotAgreementOn(env)
    ? guideText
    : guideText
        .split("\n")
        .filter((line) => !line.includes("(/admin/agreement)"))
        .join("\n");
  const text = guide
    .replaceAll("{discord}", env.SUPPORT_URL || `mailto:${env.CONTACT_EMAIL}`)
    .replaceAll("{site}", legalBase(env))
    .replaceAll("{contact}", env.CONTACT_EMAIL)
    .replaceAll("{product}", env.PRODUCT_NAME);
  return {
    html: renderMarkdown(text),
    version: APP_VERSION,
    product: env.PRODUCT_NAME,
    sourceUrl: env.SOURCE_URL || null,
  };
}

export default function AdminGuide({ loaderData }: Route.ComponentProps) {
  return (
    <section className="space-y-4">
      <PageHeader title="Admin guide" />
      <article className="guide max-w-3xl rounded-xl bg-white p-5 ring-1 ring-dust-light">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by markdown.server.ts (raw HTML off) from content/admin-guide.md */}
        <div dangerouslySetInnerHTML={{ __html: loaderData.html }} />
      </article>
      <p className="text-xs text-charcoal">
        {`${loaderData.product} version ${loaderData.version}`}
        {loaderData.sourceUrl && (
          <>
            {". "}
            <a href={loaderData.sourceUrl} className="underline">
              Source code
            </a>
          </>
        )}
      </p>
    </section>
  );
}
