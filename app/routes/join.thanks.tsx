// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link, redirect } from "react-router";
import { PublicShell } from "~/components/PublicShell";
import { Notice } from "~/components/ui";
import { getDb } from "~/lib/context.server";
import { findGuide } from "~/lib/data/guides.server";
import type { Route } from "./+types/join.thanks";

// Where the join form sends everyone (bots and over-limit IPs too, so there's nothing to
// probe). If the camp has a public Welcome guide, people land there with a thank-you note, to
// keep reading while they wait to hear back; otherwise they get the note here.
export async function loader({ context }: Route.LoaderArgs) {
  const welcome = await findGuide(getDb(context), "welcome");
  if (welcome?.visibility === "public") throw redirect("/guides/welcome?joined=1");
  return null;
}

export default function JoinThanks() {
  return (
    <PublicShell signedIn={false}>
      <Notice tone="ok">
        Thanks for reaching out! We've got your note, and a camp lead will get in touch soon. Check
        your email for a confirmation (and your spam folder, just in case).
      </Notice>
      <Link to="/guides" className="mt-4 inline-block font-semibold underline">
        Read the camp's guides
      </Link>
    </PublicShell>
  );
}
