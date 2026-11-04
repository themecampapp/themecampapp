// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

// Issue #75: Theme Camp App's "TCA" icon (platform/public/), as on the camp sites.
export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">{notFound ? "Page not found" : "Something went wrong"}</h1>
    </main>
  );
}
