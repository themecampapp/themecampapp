// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";
import { publicContext } from "../lib/context.server";
import type { Route } from "./+types/signup.thanks";

// Issue #73: after a camp's sign-up request.
export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `Thanks · ${loaderData?.product ?? ""}` },
  { name: "robots", content: "noindex" },
];

export function loader({ context }: Route.LoaderArgs) {
  const { contact, supportUrl, product } = context.get(publicContext);
  return { contact, supportUrl, product };
}

export default function Thanks({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <Link to="/" className="text-sm underline">
        {loaderData.product}
      </Link>
      <h1 className="text-3xl font-bold">Thanks!</h1>
      <p className="text-lg">
        As soon as your request is approved, you'll get an email to set up your camp.
      </p>
      {loaderData.supportUrl && (
        <section className="space-y-3 rounded-xl p-5 ring-1 ring-black/10">
          <h2 className="text-xl font-bold">Join us on Discord</h2>
          <p>
            It's where we help with setup and questions, and where you can tell us what your camp
            needs next.
          </p>
          <a
            href={loaderData.supportUrl}
            className="inline-block rounded-lg bg-black px-4 py-2 font-semibold text-white"
          >
            {`Join the ${loaderData.product} Discord`}
          </a>
        </section>
      )}
      <p className="text-sm opacity-80">
        {`Haven't heard from us in a few days? Email ${loaderData.contact}.`}
      </p>
    </main>
  );
}
