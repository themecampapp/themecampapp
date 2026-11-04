// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect } from "react-router";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { person } from "~/db/schema";
import { requireAccess } from "~/lib/access.server";
import { audit } from "~/lib/audit.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { normalizeEmail } from "~/lib/email";
import { formError } from "~/lib/errors";
import { personWithEmail, sendInvite } from "~/lib/invites.server";
import type { Route } from "./+types/_app.lead.people.new";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Add person") }];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = requireAccess(context, "people", "manage");
  const form = await request.formData();
  const legalName = String(form.get("legalName") ?? "").trim();
  const playaName = String(form.get("playaName") ?? "").trim() || null;
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const phone = String(form.get("phone") ?? "").trim() || null;
  const values = { legalName, playaName: playaName ?? "", email, phone: phone ?? "" };
  if (!legalName) return { error: "Name is required.", values };
  if (!EMAIL_RE.test(email)) {
    return { error: "A valid email is required so they can sign in.", values };
  }

  const db = getDb(context);
  // One person per email: point the Lead at the existing record instead of making a duplicate.
  // A deactivated match can be overridden (say, an old duplicate); an active one can't.
  const existing = await personWithEmail(db, email);
  if (existing && (existing.active || form.get("allowInactiveMatch") !== existing.id)) {
    return { existing, values };
  }
  const [p] = await db.insert(person).values({ legalName, playaName, email, phone }).returning();
  await audit(db, {
    actorPersonId: viewer.personId,
    action: "person_created",
    subjectType: "person",
    subjectId: p.id,
    after: { legalName, playaName, email },
  });
  if (form.get("invite") === "on") {
    try {
      await sendInvite(db, context.get(cloudflareContext).env, viewer, p.id);
    } catch (e) {
      const { error } = formError(e);
      return redirect(
        `/people/${p.id}?notice=${encodeURIComponent(`Added, but not invited: ${error}`)}`,
      );
    }
    return redirect(`/people/${p.id}?notice=${encodeURIComponent("Added and invited.")}`);
  }
  return redirect(`/people/${p.id}?notice=Added.`);
}

export default function NewPerson({ actionData }: Route.ComponentProps) {
  const existing = actionData && "existing" in actionData ? actionData.existing : null;
  const values = actionData?.values;
  return (
    <section className="max-w-lg">
      <PageHeader title="Add a person" />
      <Form method="post" className="space-y-4">
        {actionData && "error" in actionData && actionData.error && (
          <Notice tone="error">{actionData.error}</Notice>
        )}
        {existing && (
          <Notice tone="error">
            {existing.active ? (
              <>
                <Link to={`/people/${existing.id}`} className="font-semibold underline">
                  {existing.name}
                </Link>{" "}
                already has this email. Use their record instead of adding someone new.
              </>
            ) : (
              <>
                <Link to={`/people/${existing.id}`} className="font-semibold underline">
                  {existing.name}
                </Link>{" "}
                has this email but is deactivated. If it's the same person, reactivate them from
                their page to keep their history. If it's an old duplicate, you can add a new person
                anyway.
                <input type="hidden" name="allowInactiveMatch" value={existing.id} />
              </>
            )}
          </Notice>
        )}
        <Field label="Name">
          <input
            name="legalName"
            required
            defaultValue={values?.legalName}
            className={input}
            autoComplete="off"
          />
        </Field>
        <Field label="Playa name (optional)">
          <input
            name="playaName"
            defaultValue={values?.playaName}
            className={input}
            autoComplete="off"
          />
        </Field>
        <Field label="Email" hint="They'll sign in with this address.">
          <input
            name="email"
            type="email"
            required
            defaultValue={values?.email}
            className={input}
            autoComplete="off"
          />
        </Field>
        <Field label="Phone (optional)">
          <input
            name="phone"
            type="tel"
            defaultValue={values?.phone}
            className={input}
            autoComplete="off"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="invite" defaultChecked /> Email them an invite now
        </label>
        <div className="flex gap-2">
          <button type="submit" className={btn.primary}>
            {existing && !existing.active ? "Add a new person anyway" : "Add person"}
          </button>
          <Link to="/people" className={btn.secondary}>
            Cancel
          </Link>
        </div>
      </Form>
    </section>
  );
}
