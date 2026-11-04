// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data, redirect } from "react-router";
import { CampMark, CampName } from "~/components/CampName";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext } from "~/lib/context.server";
import { DEMO_ROLE, DEMO_ROLES, demoCookie, isDemoRole } from "~/lib/demo";
import type { Route } from "./+types/demo.enter";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Try the demo") }];
}

// R67, U20: the way into the demo camp, for anyone. It asks which role to see the camp as;
// `?as=<role>` sets the demo cookie for that role and opens the camp. Only GETs: the demo takes
// no writes at all. On any other camp it doesn't exist.
export function loader({ request, context }: Route.LoaderArgs) {
  const cf = context.get(cloudflareContext);
  if (cf.camp.kind !== "demo") throw data({ reason: "not_found" }, { status: 404 });
  const as = new URL(request.url).searchParams.get("as");
  if (isDemoRole(as)) {
    cf.setCookies = [...(cf.setCookies ?? []), demoCookie(as)];
    return redirect("/");
  }
  return null;
}

export default function DemoEnter() {
  return (
    <main className="mx-auto max-w-xl space-y-5 px-4 py-10">
      <p className="flex items-center gap-2 font-semibold">
        <CampMark />
        <CampName />
      </p>
      <h1 className="text-2xl font-bold">Look around a demo camp</h1>
      <p>
        Everyone here is made up. See the camp app the way each person in a camp does: you can
        switch at any time from the banner at the top. Nothing you change is saved, and no email is
        ever sent.
      </p>
      <ul className="space-y-3">
        {DEMO_ROLES.map((r) => (
          <li key={r}>
            <a
              href={`/demo/enter?as=${r}`}
              className="block rounded-xl bg-white p-4 ring-1 ring-dust-light hover:ring-gold"
            >
              <span className="font-semibold">{`View as ${r === "admin" ? "an" : "a"} ${DEMO_ROLE[r].label}`}</span>
              <span className="mt-1 block text-sm text-charcoal">{DEMO_ROLE[r].sees}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
