// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link } from "react-router";
import { BM_DISCLAIMER } from "~/lib/disclaimer";
import { featureOn } from "~/lib/instance-features";
import { pilotAgreementOn } from "~/lib/legal";
import { publicContext } from "../lib/context.server";
import type { Route } from "./+types/_index";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: loaderData?.product ?? "" },
  {
    name: "description",
    content: "The camp app for Burning Man theme camps: people, RSVPs, tickets, dues and guides.",
  },
];

// R71: the public site for the pilot. What it is, how camps ask to join (issue #73: the
// sign-up page), how to get in touch, the demo, and the legal pages.
export function loader({ context }: Route.LoaderArgs) {
  const { domain, contact, product, env, sourceUrl } = context.get(publicContext);
  return {
    demo: `https://demo.${domain}`,
    contact,
    product,
    sourceUrl,
    pilotAgreement: pilotAgreementOn(env),
    signupPage: featureOn(env, "signupPage"),
  };
}

const FEATURES = [
  ["People and invites", "Everyone in one list. Invite them by email; no passwords."],
  ["RSVPs and logistics", "Who's coming, when they arrive, what they're bringing."],
  ["Stewards Sale requests", "Collect ticket and vehicle pass requests, lock them, send the list."],
  ["Dues", "The Treasurer tracks who's paid. Nobody else sees it."],
  ["Guides", "Your camp's how-tos, from joining to strike, in one place."],
  ["Yearbook and directory", "Faces and playa names, and contact details people choose to share."],
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { demo, contact, product, pilotAgreement, signupPage, sourceUrl } = loaderData;
  return (
    <main className="mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-4">
        <h1 className="text-4xl font-bold">{product}</h1>
        <p className="text-lg">
          The camp app for Burning Man theme camps: your people, RSVPs, Stewards Sale ticket
          requests, dues and guides, in one place your whole camp can use.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href={demo} className="rounded-lg bg-black px-4 py-2 font-semibold text-white">
            Look around the demo camp
          </a>
          <a href={`mailto:${contact}`} className="rounded-lg px-4 py-2 font-semibold ring-1">
            Get in touch
          </a>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map(([title, text]) => (
          <div key={title} className="rounded-xl p-4 ring-1 ring-black/10">
            <h2 className="font-semibold">{title}</h2>
            <p className="text-sm opacity-80">{text}</p>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold">A small pilot</h2>
        <p>
          {`We're running ${product} with a group of camps for the 2027 burn. If your camp would like to try it,`}{" "}
          {signupPage && (
            <>
              <Link to="/signup" className="underline">
                ask to join the pilot
              </Link>{" "}
              or{" "}
            </>
          )}
          email{" "}
          <a href={`mailto:${contact}`} className="underline">
            {contact}
          </a>
          .
        </p>
        <p>
          The demo camp is full of made-up people. Click around as one of its Leads; nothing you
          change is saved.
        </p>
      </section>

      {/* Issue #99. The same promise is in the sign-up page, the pilot agreement and the Terms. */}
      <section className="space-y-2">
        <h2 className="text-xl font-bold">Free for camps, for good</h2>
        <p>
          {`${product} is free, and the people who build it are committed to keeping it free for theme camp organizers for as long as we have the time and energy to run it. We may one day ask for donations to help cover costs. Giving will always be optional, and nothing in the app will ever depend on it.`}
        </p>
        {sourceUrl && (
          <p>
            {"The code is "}
            <a href={sourceUrl} className="underline">
              open source
            </a>
            {", so anyone who'd rather run their own copy always can."}
          </p>
        )}
      </section>

      <footer className="space-y-2 border-t pt-6 text-sm opacity-80">
        <nav className="flex flex-wrap gap-4">
          <Link to="/legal/terms" className="underline">
            Terms of Service
          </Link>
          <Link to="/legal/privacy" className="underline">
            Privacy Policy
          </Link>
          <Link to="/legal/data-handling" className="underline">
            How we handle data
          </Link>
          {pilotAgreement && (
            <Link to="/legal/pilot-agreement" className="underline">
              Pilot agreement
            </Link>
          )}
          {sourceUrl && (
            <a href={sourceUrl} className="underline">
              Source code
            </a>
          )}
        </nav>
        <p>{`Contact and abuse reports: ${contact}.`}</p>
        <p>{BM_DISCLAIMER}</p>
      </footer>
    </main>
  );
}
