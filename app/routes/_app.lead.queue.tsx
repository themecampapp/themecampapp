// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, inArray } from "drizzle-orm";
import { data, Form } from "react-router";
import { PersonLink } from "~/components/PersonLink";
import { btn, Notice, PageHeader } from "~/components/ui";
import { user } from "~/db/auth-schema";
import { leadQueueItem, person } from "~/db/schema";
import { requireAccess } from "~/lib/access.server";
import { audit } from "~/lib/audit.server";
import { pageTitle } from "~/lib/camp";
import { getDb } from "~/lib/context.server";
import type { Route } from "./+types/_app.lead.queue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Lead queue") }];
}

const KIND: Record<string, { title: string; help: string }> = {
  link_conflict: {
    title: "Sign-in couldn't be linked",
    help: "Someone signed in with an email that's on more than one invite. Give each person their own email (or deactivate a duplicate), then have them sign in again.",
  },
  shared_email: {
    title: "Shared email",
    help: "Two active people have the same email, so neither can be invited until one is changed.",
  },
  no_email: { title: "No email", help: "Add an email so they can be invited." },
  email_change_conflict: {
    title: "Email change blocked",
    help: "Someone tried to change their email to one another person uses.",
  },
  send_failure: {
    title: "Email failed",
    help: "An email didn't send. Check the address and resend.",
  },
};

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const items = await db
    .select()
    .from(leadQueueItem)
    .where(eq(leadQueueItem.status, "open"))
    .orderBy(desc(leadQueueItem.createdAt));

  const personIds = new Set<string>();
  const authIds = new Set<string>();
  for (const i of items) {
    if (i.personId) personIds.add(i.personId);
    if (i.authUserId) authIds.add(i.authUserId);
    const invited = (i.payload as { invitedPersonIds?: string[] } | null)?.invitedPersonIds ?? [];
    for (const id of invited) personIds.add(id);
  }
  const people = personIds.size
    ? await db
        .select({ id: person.id, name: person.legalName, playa: person.playaName })
        .from(person)
        .where(inArray(person.id, [...personIds]))
    : [];
  const logins = authIds.size
    ? await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(inArray(user.id, [...authIds]))
    : [];

  return {
    items: items.map((i) => {
      const invited = (i.payload as { invitedPersonIds?: string[] } | null)?.invitedPersonIds ?? [];
      return {
        id: i.id,
        kind: i.kind,
        createdAt: i.createdAt.toISOString(),
        loginEmail: logins.find((l) => l.id === i.authUserId)?.email ?? null,
        people: people
          .filter((p) => p.id === i.personId || invited.includes(p.id))
          .map((p) => ({ id: p.id, name: p.playa ?? p.name })),
      };
    }),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = requireAccess(context, "people", "manage");
  const db = getDb(context);
  const id = String((await request.formData()).get("id"));
  if (!UUID_RE.test(id)) throw data({ reason: "not_found" }, { status: 404 });
  const resolved = await db
    .update(leadQueueItem)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedByPersonId: viewer.personId })
    .where(and(eq(leadQueueItem.id, id), eq(leadQueueItem.status, "open")))
    .returning({ id: leadQueueItem.id });
  if (resolved.length) {
    await audit(db, {
      actorPersonId: viewer.personId,
      action: "queue_item_resolved",
      subjectType: "lead_queue_item",
      subjectId: id,
    });
  }
  return { ok: true };
}

export default function Queue({ loaderData }: Route.ComponentProps) {
  const { items } = loaderData;
  return (
    <section className="max-w-2xl">
      <PageHeader title="Lead queue" />
      {items.length === 0 ? (
        <Notice>Nothing needs attention.</Notice>
      ) : (
        <ul className="space-y-3">
          {items.map((i) => (
            <li key={i.id} className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="font-semibold">{KIND[i.kind]?.title ?? i.kind}</div>
                  <p className="text-sm text-charcoal">{KIND[i.kind]?.help}</p>
                  {i.loginEmail && <p className="text-sm">Login: {i.loginEmail}</p>}
                  {i.people.length > 0 && (
                    <p className="text-sm">
                      People:{" "}
                      {i.people.map((p, n) => (
                        <span key={p.id}>
                          {n > 0 && ", "}
                          <PersonLink id={p.id} className="underline">
                            {p.name}
                          </PersonLink>
                        </span>
                      ))}
                    </p>
                  )}
                  <p className="text-xs text-charcoal">{new Date(i.createdAt).toLocaleString()}</p>
                </div>
                <Form method="post">
                  <input type="hidden" name="id" value={i.id} />
                  <button type="submit" className={btn.secondary}>
                    Mark resolved
                  </button>
                </Form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
