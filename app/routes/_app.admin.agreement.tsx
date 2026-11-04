// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { data, Form, redirect } from "react-router";
import { btn, Notice, PageHeader } from "~/components/ui";
import { person } from "~/db/schema";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { acceptAgreement, agreementHtml, agreementStatus } from "~/lib/data/agreement.server";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.admin.agreement";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Pilot agreement · Admin") }];
}

// R68: the pilot agreement. Until one of the camp's Admins accepts it, the app's other pages
// send Admins here (the _app layout's middleware). Afterwards it stays here to read.
export async function loader({ context }: Route.LoaderArgs) {
  // An instance without a pilot agreement (config legal.pilotAgreement) has no such page.
  const html = agreementHtml(context.get(cloudflareContext).env);
  if (html === null) throw data({ reason: "not_found" }, { status: 404 });
  const db = getDb(context);
  const settings = await getSettings(context);
  const status = await agreementStatus(db);
  let acceptedBy: string | null = null;
  if (status?.by) {
    const [p] = await db
      .select({ legalName: person.legalName, playaName: person.playaName })
      .from(person)
      .where(eq(person.id, status.by));
    acceptedBy = p ? (p.playaName ?? p.legalName) : null;
  }
  return {
    camp: settings.name,
    html,
    accepted: status?.at ? { at: status.at.toISOString().slice(0, 10), by: acceptedBy } : null,
    required: settings.setup.createdInConsole,
  };
}

export async function action({ context }: Route.ActionArgs) {
  try {
    await acceptAgreement(getDb(context), getViewer(context));
  } catch (e) {
    return formError(e);
  }
  return redirect("/");
}

export default function Agreement({ loaderData, actionData }: Route.ComponentProps) {
  const { camp, html, accepted, required } = loaderData;
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Pilot agreement" />
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      {accepted ? (
        <Notice tone="ok">
          {`Accepted for ${camp}${accepted.by ? ` by ${accepted.by}` : ""} on ${accepted.at}.`}
        </Notice>
      ) : (
        required && (
          <p className="text-sm">
            {`Welcome! Before you set up ${camp}, please read the pilot agreement and accept it for the camp.`}
          </p>
        )
      )}
      <article className="guide rounded-xl bg-white p-5 ring-1 ring-dust-light">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by markdown.server.ts (raw HTML off) from content/legal */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
      {!accepted && required && (
        <Form method="post" className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="agree" required className="mt-1" />
            <span>{`I've read this and accept it on behalf of ${camp}.`}</span>
          </label>
          <button type="submit" className={btn.primary}>
            Accept and continue
          </button>
        </Form>
      )}
    </section>
  );
}
