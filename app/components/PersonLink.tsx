// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { personHref } from "~/lib/back-link";

// A link to a person's page that brings the Lead back to this exact list (filters, search
// and all) when they're done there.
export function PersonLink({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const { pathname, search } = useLocation();
  return (
    <Link to={personHref(id, `${pathname}${search}`)} className={className}>
      {children}
    </Link>
  );
}
