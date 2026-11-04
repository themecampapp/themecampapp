// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { accessErrorPage } from "./components/AccessError";
import { ErrorBeacon, reportClientError } from "./components/ErrorBeacon";
import { LegalLinks } from "./components/LegalLinks";
import { PendingFeedback } from "./components/PendingFeedback";
import { accentPalette, type CampInfo } from "./lib/camp";
import { cloudflareContext, getSettings } from "./lib/context.server";
import { fileName } from "./lib/files.server";
import { legalBase } from "./lib/hosts";

// R67: the demo camp saves nothing. The Worker turns away a plain form post; a page's own
// (client-side) post reaches here, and is refused before any action runs, with a page that
// says why rather than an error.
export const middleware: Route.MiddlewareFunction[] = [
  ({ request, context }) => {
    const { camp } = context.get(cloudflareContext);
    if (camp.kind === "demo" && request.method !== "GET" && request.method !== "HEAD") {
      throw data({ reason: "demo_read_only" }, { status: 403 });
    }
  },
];

// Every page's camp name (titles, headers) and accent colour.
export async function loader({ context }: Route.LoaderArgs): Promise<CampInfo> {
  const settings = await getSettings(context);
  return {
    campName: settings.name,
    productName: context.get(cloudflareContext).env.PRODUCT_NAME,
    accent: settings.accent,
    logoUrl: settings.logoKey ? `/logo/${fileName(settings.logoKey)}` : null,
    legalBase: legalBase(context.get(cloudflareContext).env),
    sourceUrl: context.get(cloudflareContext).env.SOURCE_URL ?? "",
  };
}

export const links: Route.LinksFunction = () => [
  // Issue #75: Theme Camp App's "TCA" icon (public/), the same for every camp.
  { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const camp = useRouteLoaderData("root") as CampInfo | undefined;
  // Signed-in pages have their own footer (routes/_app.tsx), with these links in it.
  const signedIn = useMatches().some((m) => m.id === "routes/_app");
  // The camp's accent replaces the default highlight colour everywhere, with its lighter
  // shades (hover, banners, glows) mixed from it, so nothing stays the default gold.
  const style = camp?.accent ? (accentPalette(camp.accent) as React.CSSProperties) : undefined;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={style}>
        {signedIn ? (
          children
        ) : (
          // A full-height column, so the legal links sit at the foot of even a short page.
          <div className="flex min-h-dvh flex-col">
            <div className="flex flex-1 flex-col">{children}</div>
            <footer className="px-4 pt-4 pb-6 text-xs text-charcoal">
              <LegalLinks className="justify-center" />
            </footer>
          </div>
        )}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <PendingFeedback />
      <ErrorBeacon />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // A page that broke while rendering in the browser (R74: its type and route only).
  const matches = useMatches();
  const route = matches[matches.length - 1]?.id;
  useEffect(() => {
    if (!isRouteErrorResponse(error)) reportClientError(error, route);
  }, [error, route]);
  const access = accessErrorPage(error);
  if (access) return access;
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = "Error";
    details = error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pt-16">
      <h1 className="text-2xl font-bold">{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
