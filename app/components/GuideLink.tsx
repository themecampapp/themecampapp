// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { loader as appLoader } from "~/routes/_app";

// A link to one of the camp's guides, shown only if the camp has published a guide with that
// slug that this member can read. Guides are each camp's own, so "/guides/dues" may not exist.
// Whether the camp has published a guide with this slug that this member can read.
export function useHasGuide(slug: string) {
  const slugs = useRouteLoaderData<typeof appLoader>("routes/_app")?.guideSlugs ?? [];
  return slugs.includes(slug);
}

export function GuideLink({
  slug,
  className,
  children,
}: {
  slug: string;
  className?: string;
  children: ReactNode;
}) {
  if (!useHasGuide(slug)) return null;
  return (
    <Link to={`/guides/${slug}`} className={className}>
      {children}
    </Link>
  );
}
