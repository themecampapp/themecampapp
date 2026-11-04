// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { Link, redirect } from "react-router";
import { PageHeader } from "~/components/ui";
import { WhoSeesWhat } from "~/components/WhoSeesWhat";
import { person } from "~/db/schema";
import { getViewer } from "~/lib/access.server";
import { pageTitle, useCamp } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { whoSees } from "~/lib/data/camp-roles.server";
import type { Route } from "./+types/_app.privacy-notice";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Who can see what") }];
}

// R51: the first-sign-in privacy notice, here to read again any time (issue #93: who sees
// what follows the camp's roles, so it can change after someone has said "Got it").
export async function loader({ context }: Route.LoaderArgs) {
  const who = await whoSees(getDb(context), (await getSettings(context)).features);
  return { seesPrivate: who.private, seesDues: who.dues };
}

// "Got it" on the notice. Records when, so it isn't shown again.
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  await getDb(context)
    .update(person)
    .set({ privacyNoticeSeenAt: new Date() })
    .where(eq(person.id, viewer.personId));
  const next = new URL(request.headers.get("Referer") ?? "/", "https://x").pathname;
  return redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export default function PrivacyNotice({ loaderData }: Route.ComponentProps) {
  const { campName, legalBase } = useCamp();
  return (
    <section className="max-w-2xl space-y-4">
      <PageHeader title="Who can see what" />
      <div className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <WhoSeesWhat
          campName={campName}
          seesPrivate={loaderData.seesPrivate}
          seesDues={loaderData.seesDues}
        />
      </div>
      <p className="text-sm text-charcoal">
        More in the{" "}
        <a href={`${legalBase}/legal/privacy`} className="underline">
          privacy policy
        </a>
        .{" "}
        <Link to="/profile" className="underline">
          Back to your profile
        </Link>
      </p>
    </section>
  );
}
