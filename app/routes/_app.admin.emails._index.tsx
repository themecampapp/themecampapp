// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Link, useSearchParams } from "react-router";
import { Notice, PageHeader } from "~/components/ui";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import { listTemplates } from "~/lib/data/email-templates.server";
import type { Route } from "./+types/_app.admin.emails._index";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Emails · Admin") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { features } = await getSettings(context);
  const templates = await listTemplates(getDb(context));
  return { templates: templates.filter((t) => !t.feature || features[t.feature]) };
}

export default function Emails({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <section className="max-w-2xl space-y-4">
      <PageHeader title="Emails" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      <p className="text-sm text-charcoal">
        The wording of the emails the app sends. Edit one to change it for everyone from now on; you
        can always reset it. The sign-in link email and the Lead notification about new inquiries
        can't be changed.
      </p>
      <ul className="divide-y divide-dust-light rounded-xl bg-white ring-1 ring-dust-light">
        {loaderData.templates.map((t) => (
          <li key={t.kind}>
            <Link
              to={`/admin/emails/${t.kind}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 px-4 py-3 hover:bg-dust-pale"
            >
              <span>
                <span className="font-semibold">{t.name}</span>
                <span className="block text-sm text-charcoal">{t.when}</span>
              </span>
              <span className="text-sm text-charcoal">
                {t.customizedAt
                  ? `Edited ${new Date(t.customizedAt).toLocaleDateString()}`
                  : "Default wording"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
