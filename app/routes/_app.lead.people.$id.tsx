// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { MailingAddressFields } from "~/components/MailingAddressFields";
import { btn, Field, INTENT_LABEL, input, Notice, PageHeader, STATUS_LABEL } from "~/components/ui";
import { photoUrl } from "~/components/Yearbook";
import { burn, invite, participation, person } from "~/db/schema";
import { can, getViewer, type Viewer } from "~/lib/access.server";
import { audit } from "~/lib/audit.server";
import { backLink, DEFAULT_BACK } from "~/lib/back-link";
import { pageTitle } from "~/lib/camp";
import { sharesContact } from "~/lib/contact-sharing.server";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { activeCustomRoles, BUILTIN_LABEL } from "~/lib/data/camp-roles.server";
import { type CampYearValue, pastSeasons, setCampYear } from "~/lib/data/history.server";
import { NUDGE_COOLDOWN_DAYS, nudgeCandidates, sendRsvpNudges } from "~/lib/data/nudge.server";
import { currentYear } from "~/lib/data/participation.server";
import { rolesFor } from "~/lib/data/volunteer.server";
import { formError } from "~/lib/errors";
import {
  changeEmailBeforeSignIn,
  inviteBlocker,
  sendInvite,
  unlinkLogin,
} from "~/lib/invites.server";
import { loginManagementReason } from "~/lib/login-management";
import { heldNotice } from "~/lib/mail.server";
import { readMailingAddress } from "~/lib/mailing-address";
import { accessSummary } from "~/lib/permissions";
import { personHistory } from "~/lib/person-history.server";
import { removePhoto } from "~/lib/photos.server";
import { accessOf, heldRoles } from "~/lib/role-access.server";
import {
  deactivatePerson,
  grantRole,
  type RoleRef,
  reactivatePerson,
  revokeRole,
} from "~/lib/roles.server";
import type { Route } from "./+types/_app.lead.people.$id";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  const p = loaderData?.person;
  return [{ title: pageTitle(matches, `${p?.playaName ?? p?.legalName ?? "Person"}`) }];
}

const CAMP_YEAR_LABEL: Record<CampYearValue, string> = {
  yes: "Came",
  no: "Didn't come",
  unknown: "Unknown",
};
const campYearValue = (attended: boolean | null | undefined): CampYearValue =>
  attended === true ? "yes" : attended === false ? "no" : "unknown";

// Issue #93: without Private details & notes, a person's contact details show (and can be
// changed) only if they share them in the directory, and their mailing address and note never.
const seesContact = (
  viewer: Viewer,
  p: { id: string; directoryChoiceSeenAt: Date | null; directoryHidden: boolean },
) => can(viewer, "private") || p.id === viewer.personId || sharesContact(p);

// A role picked in the form: a built-in one, or "custom:<id>".
function readRole(value: unknown): RoleRef | null {
  const v = String(value ?? "");
  if (v === "lead" || v === "treasurer" || v === "admin") return v;
  const id = v.startsWith("custom:") ? v.slice(7) : "";
  return /^[0-9a-f-]{36}$/i.test(id) ? { customRoleId: id } : null;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const db = getDb(context);
  const [p] = await db.select().from(person).where(eq(person.id, params.id));
  if (!p) throw data({ reason: "not_found" }, { status: 404 });

  const viewer = getViewer(context);
  const held = ((await heldRoles(db, [p.id])).get(p.id) ?? []).filter((h) => !h.archived);
  const target = accessOf(held);
  const [pending] = await db
    .select()
    .from(invite)
    .where(and(eq(invite.personId, p.id), eq(invite.status, "pending")));
  const year = await currentYear(db);
  const seasons = await db
    .select({
      year: burn.year,
      intent: participation.intent,
      attended: participation.attended,
      preBurn: participation.preBurnIntent,
    })
    .from(participation)
    .innerJoin(burn, eq(burn.id, participation.burnId))
    .where(eq(participation.personId, p.id));
  const allHistory = new URL(request.url).searchParams.get("history") === "all";
  const history = await personHistory(db, p.id, allHistory ? 1000 : 25, {
    dues: can(viewer, "dues"),
  });

  // The list the Lead came from (Unit 4 of the Lead workspace plan), kept across saves.
  const back = backLink(new URL(request.url).searchParams.get("back"));
  // Issue #78: the camp collects mailing addresses (Admin → Features). Switched off, a saved
  // address stays but isn't shown.
  const { features } = await getSettings(context);
  const seesPrivate = can(viewer, "private");
  const contact = seesContact(viewer, p);
  const mailing = features.mailing && seesPrivate;
  return {
    back,
    mailing,
    contact,
    person: {
      id: p.id,
      legalName: p.legalName,
      playaName: p.playaName,
      email: contact ? p.email : null,
      phone: contact ? p.phone : null,
      homeLocation: contact ? p.homeLocation : null,
      mailingAddress: mailing ? p.mailingAddress : null,
      note2026: seesPrivate ? p.note2026 : null,
      photoUrl: p.photoKey ? photoUrl(p.photoKey) : null,
      active: p.active,
      signedIn: !!p.authUserId,
    },
    // Their roles (issue #93), with what they add up to.
    roles: held.map((h) =>
      h.role === "custom"
        ? { value: `custom:${h.customRoleId}`, label: h.name ?? "Custom role" }
        : {
            value: h.role,
            label: h.role === "admin" ? "Admin" : BUILTIN_LABEL[h.role as "lead" | "treasurer"],
          },
    ),
    summary: target.isAdmin
      ? "Can do everything, including the Admin pages."
      : accessSummary(target.access, features),
    // What an Admin can give them: the roles they don't have yet.
    addable: viewer.isAdmin
      ? [
          { value: "lead", label: "Lead" },
          { value: "treasurer", label: "Treasurer" },
          ...(await activeCustomRoles(db)).map((r) => ({
            value: `custom:${r.id}`,
            label: r.name ?? "Custom role",
          })),
          { value: "admin", label: "Admin" },
        ].filter(
          (r) =>
            !held.some(
              (h) => (h.role === "custom" ? `custom:${h.customRoleId}` : h.role) === r.value,
            ),
        )
      : [],
    loginManagementReason: loginManagementReason(viewer, target, features),
    // Links and actions in other areas, shown only to people who can use them.
    can: {
      rsvp: can(viewer, "roster", "manage"),
      campYears: can(viewer, "roster", "manage"),
    },
    pendingInviteSentAt: pending?.sentAt?.toISOString() ?? null,
    inviteBlocker: await inviteBlocker(db, p.id),
    campYears: (await pastSeasons(db)).map((year) => ({
      year,
      value: campYearValue(seasons.find((s) => s.year === year)?.attended),
    })),
    year,
    current: seasons.find((s) => s.year === year) ?? null,
    history: history.entries,
    moreHistory: history.more,
    viewerIsAdmin: viewer.isAdmin === true,
    // Issue #106: their jobs this season (the former elected positions included).
    jobs: features.volunteer ? ((await rolesFor(db, [p.id])).get(p.id) ?? []) : [],
    // Set only while they're on the No RSVP list (invited or signed in, no RSVP, has an email).
    nudge: can(viewer, "roster", "manage")
      ? ((await nudgeCandidates(db)).find((c) => c.personId === p.id) ?? null)
      : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const env = context.get(cloudflareContext).env;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = params.id;
  const backParam = new URL(request.url).searchParams.get("back");
  const keepBack = backParam ? `&back=${encodeURIComponent(backLink(backParam).to)}` : "";
  const done = (msg: string) =>
    redirect(`/people/${id}?notice=${encodeURIComponent(msg)}${keepBack}`);
  // Only this camp's people exist here (row-level security): anyone else is a 404, never a
  // quiet no-op with a success notice.
  const [exists] = await db.select({ id: person.id }).from(person).where(eq(person.id, id));
  if (!exists) throw data({ reason: "not_found" }, { status: 404 });

  try {
    switch (intent) {
      case "update": {
        const legalName = String(form.get("legalName") ?? "").trim();
        if (!legalName) return { error: "Name is required." };
        const [before] = await db.select().from(person).where(eq(person.id, id));
        if (!before) throw data({ reason: "not_found" }, { status: 404 });
        // Issue #93: only the fields this viewer was shown are saved; anything hidden from them
        // stays as it is, whatever the form sends.
        const contact = seesContact(viewer, before);
        // Only while the camp collects them; otherwise a saved address is left as it is.
        const mailing =
          (await getSettings(context)).features.mailing && can(viewer, "private")
            ? readMailingAddress((k) => String(form.get(k) ?? ""))
            : null;
        if (mailing && "problem" in mailing) return { error: mailing.problem };
        const next = {
          legalName,
          playaName: String(form.get("playaName") ?? "").trim() || null,
          ...(contact
            ? {
                phone: String(form.get("phone") ?? "").trim() || null,
                homeLocation: String(form.get("homeLocation") ?? "").trim() || null,
              }
            : {}),
          ...(mailing ? { mailingAddress: mailing.address } : {}),
        };
        await db
          .update(person)
          .set({ ...next, updatedAt: new Date() })
          .where(eq(person.id, id));
        await audit(db, {
          actorPersonId: viewer.personId,
          action: "person_updated",
          subjectType: "person",
          subjectId: id,
          before: {
            legalName: before.legalName,
            playaName: before.playaName,
            ...(contact ? { phone: before.phone, homeLocation: before.homeLocation } : {}),
            ...(mailing ? { mailingAddress: before.mailingAddress } : {}),
          },
          after: next,
        });
        const email = form.get("email");
        if (
          contact &&
          typeof email === "string" &&
          email.trim() &&
          email.trim().toLowerCase() !== before.email
        ) {
          await changeEmailBeforeSignIn(db, env, viewer, id, email);
        }
        return done("Saved.");
      }
      case "invite":
        await sendInvite(db, env, viewer, id);
        return done("Invite sent.");
      case "unlink":
        await unlinkLogin(db, viewer, id);
        return done("Login unlinked. Fix their email if needed, then send a new invite.");
      case "grant":
      case "revoke": {
        const role = readRole(form.get("role"));
        if (!role) return { error: "Pick a role." };
        // Making someone an Admin hands them everything, so it's asked twice.
        if (
          intent === "grant" &&
          role === "admin" &&
          viewer.isAdmin &&
          form.get("confirmed") !== "1"
        ) {
          return { confirmAdmin: true };
        }
        if (intent === "grant") await grantRole(db, viewer, id, role);
        else await revokeRole(db, viewer, id, role);
        return done(intent === "grant" ? "Role given." : "Role removed.");
      }
      case "deactivate":
        await deactivatePerson(db, viewer, id);
        // Retention: a deactivated person's photo is deleted, not just hidden.
        await removePhoto(db, env, viewer, id);
        return done(
          "Deactivated. They're signed out and can't sign in, and their photo was deleted.",
        );
      case "remove_photo":
        await removePhoto(db, env, viewer, id, { notify: true });
        return done("Photo removed. They've been emailed.");
      case "nudge": {
        const r = await sendRsvpNudges(db, env, viewer, [id]);
        return done(
          r.sent
            ? "RSVP nudge sent."
            : r.failed
              ? "The nudge email didn't send; see the Queue."
              : (heldNotice(r.held) ??
                `Not sent: they were nudged in the last ${NUDGE_COOLDOWN_DAYS} days, or they've RSVP'd.`),
        );
      }
      case "camp_years": {
        for (const year of await pastSeasons(db)) {
          const v = form.get(`year_${year}`);
          if (v === "yes" || v === "no" || v === "unknown") {
            await setCampYear(db, viewer, id, year, v);
          }
        }
        return done("Camp years saved.");
      }
      case "reactivate":
        await reactivatePerson(db, viewer, id);
        return done("Reactivated.");
      default:
        return { error: "Unknown action." };
    }
  } catch (e) {
    return formError(e);
  }
}

export default function PersonPage({ loaderData, actionData }: Route.ComponentProps) {
  const { person: p, roles, campYears, year, current, history, moreHistory } = loaderData;
  const [params] = useSearchParams();
  const notice = params.get("notice");
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  const confirmAdmin = actionData && "confirmAdmin" in actionData;
  const loginRestriction =
    loaderData.loginManagementReason === "admin_only"
      ? "Only an Admin can manage this person's sign-in access."
      : loaderData.loginManagementReason === "more_access"
        ? "This person can do things you can't, so only an Admin (or someone with at least their access) can manage their sign-in access."
        : null;

  return (
    <section className="max-w-2xl space-y-6">
      <div>
        <Link to={loaderData.back.to} className="text-sm underline">
          {`← ${loaderData.back.label}`}
        </Link>
        <PageHeader title={p.playaName ?? p.legalName}>
          {!p.active && (
            <span className="rounded-full bg-coral/10 px-3 py-1 text-sm text-coral-ink">
              Deactivated
            </span>
          )}
        </PageHeader>
        {notice && <Notice tone="ok">{notice}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>

      <div className="grid gap-3 rounded-xl bg-white p-4 text-sm ring-1 ring-dust-light sm:grid-cols-2">
        <div>
          <div className="font-medium">Sign-in</div>
          <div className="text-charcoal">
            {p.signedIn
              ? STATUS_LABEL.signed_in
              : loaderData.pendingInviteSentAt
                ? `${STATUS_LABEL.invited} ${new Date(loaderData.pendingInviteSentAt).toLocaleDateString()}`
                : STATUS_LABEL.not_invited}
          </div>
        </div>
        <div>
          <div className="font-medium">{year}</div>
          <div className="text-charcoal">
            {current?.intent ? INTENT_LABEL[current.intent] : "No RSVP yet"}
            {loaderData.can.rsvp && (
              <>
                {" · "}
                <Link
                  to={`/people/${p.id}/rsvp${loaderData.back.to === DEFAULT_BACK.to ? "" : `?back=${encodeURIComponent(loaderData.back.to)}`}`}
                  className="underline"
                >
                  edit
                </Link>
              </>
            )}
          </div>
          {loaderData.nudge && (
            <Form method="post" className="mt-1">
              <input type="hidden" name="intent" value="nudge" />
              <button
                type="submit"
                className="text-sm font-semibold underline disabled:font-normal disabled:no-underline disabled:opacity-60"
                disabled={!loaderData.nudge.canNudge}
              >
                Send RSVP nudge email
              </button>
              {loaderData.nudge.lastNudgedAt && (
                <span className="block text-xs text-charcoal">
                  {`Last nudged ${new Date(loaderData.nudge.lastNudgedAt).toLocaleDateString()}`}
                </span>
              )}
            </Form>
          )}
        </div>
        <div>
          <div className="font-medium">Camp years</div>
          <div className="text-charcoal">
            {campYears
              .filter((y) => y.value === "yes")
              .map((y) => y.year)
              .join(" · ") || "None recorded"}
          </div>
        </div>
        <div>
          <div className="font-medium">Roles</div>
          <div className="text-charcoal">{roles.map((r) => r.label).join(", ") || "Member"}</div>
        </div>
        {loaderData.jobs.length > 0 && (
          <div>
            <div className="font-medium">Jobs</div>
            <div className="text-charcoal">{loaderData.jobs.join(", ")}</div>
          </div>
        )}
        {p.note2026 && (
          <div className="sm:col-span-2">
            <div className="font-medium">2026 note (private)</div>
            <div className="text-charcoal">{p.note2026}</div>
          </div>
        )}
      </div>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Details</h2>
        <input type="hidden" name="intent" value="update" />
        <Field label="Name">
          <input name="legalName" defaultValue={p.legalName} required className={input} />
        </Field>
        <Field label="Playa name">
          <input name="playaName" defaultValue={p.playaName ?? ""} className={input} />
        </Field>
        {!loaderData.contact && (
          <p className="text-sm text-charcoal">
            Their email, phone and home location are hidden: they don't share them in the directory,
            and your roles don't include Private details & notes.
          </p>
        )}
        {loaderData.contact && (
          <>
            <Field
              label="Email"
              hint={
                loginRestriction ??
                (p.signedIn
                  ? "Locked: this is their sign-in address. Unlink their login below if it's wrong."
                  : "Changing it re-sends any pending invite to the new address.")
              }
            >
              <input
                name="email"
                type="email"
                defaultValue={p.email ?? ""}
                disabled={p.signedIn || !!loaderData.loginManagementReason}
                className={input}
              />
            </Field>
            <Field label="Phone">
              <input name="phone" defaultValue={p.phone ?? ""} className={input} />
            </Field>
            <Field label="Home location">
              <input name="homeLocation" defaultValue={p.homeLocation ?? ""} className={input} />
            </Field>
          </>
        )}
        {loaderData.mailing && (
          <fieldset className="space-y-3 border-t border-dust-light pt-4">
            <legend className="font-semibold">
              Mailing address <span className="font-normal text-charcoal">(optional)</span>
            </legend>
            <MailingAddressFields value={p.mailingAddress} />
          </fieldset>
        )}
        <button type="submit" className={btn.primary}>
          Save
        </button>
      </Form>

      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Access</h2>
        {loginRestriction && <p className="text-sm text-charcoal">{loginRestriction}</p>}
        {p.photoUrl && (
          <div className="flex items-center gap-3">
            <img
              src={p.photoUrl}
              alt="Their yearbook headshot"
              className="h-16 w-16 rounded-lg object-cover ring-1 ring-dust"
            />
            <Form method="post">
              <input type="hidden" name="intent" value="remove_photo" />
              <button type="submit" className="text-sm underline">
                Remove photo (emails them)
              </button>
            </Form>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!p.signedIn && p.active && !loaderData.loginManagementReason && (
            <Form method="post">
              <input type="hidden" name="intent" value="invite" />
              <button type="submit" className={btn.secondary} disabled={!!loaderData.inviteBlocker}>
                {loaderData.pendingInviteSentAt ? "Resend invite" : "Send invite"}
              </button>
            </Form>
          )}
          {p.signedIn && !loaderData.loginManagementReason && (
            <Form method="post">
              <input type="hidden" name="intent" value="unlink" />
              <button type="submit" className={btn.secondary}>
                Unlink login
              </button>
            </Form>
          )}
          <Form method="post">
            <input type="hidden" name="intent" value={p.active ? "deactivate" : "reactivate"} />
            <button type="submit" className={p.active ? btn.danger : btn.secondary}>
              {p.active ? "Deactivate" : "Reactivate"}
            </button>
          </Form>
        </div>
        {!p.signedIn && loaderData.inviteBlocker && loaderData.inviteBlocker !== "inactive" && (
          <p className="text-sm text-charcoal">
            Can't invite yet:{" "}
            {loaderData.inviteBlocker === "no_email"
              ? "add a valid email first."
              : loaderData.inviteBlocker === "shared_email"
                ? "another active person has the same email."
                : loaderData.inviteBlocker}
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Roles</h2>
        {roles.length > 0 && <p className="text-sm">{loaderData.summary}</p>}
        {roles.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {roles.map((r) => (
              <li key={r.value} className="flex items-center gap-3">
                <span className="font-medium">{r.label}</span>
                {loaderData.viewerIsAdmin && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="role" value={r.value} />
                    <button type="submit" className="underline">
                      Remove
                    </button>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-charcoal">No roles: they can do what every member can.</p>
        )}
        {!loaderData.viewerIsAdmin ? (
          <p className="text-sm text-charcoal">Only Admins change roles.</p>
        ) : !p.active ? (
          <p className="text-sm text-charcoal">Reactivate them to give them a role.</p>
        ) : confirmAdmin ? (
          <Form
            method="post"
            className="space-y-2 rounded-lg bg-coral/10 p-3 text-sm ring-1 ring-coral/40"
          >
            <input type="hidden" name="intent" value="grant" />
            <input type="hidden" name="role" value="admin" />
            <input type="hidden" name="confirmed" value="1" />
            <p>
              Admins can do everything, including the Admin pages and giving people roles. Make them
              an Admin?
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={btn.danger}>
                Make them an Admin
              </button>
              <Link to="." className={btn.secondary}>
                Cancel
              </Link>
            </div>
          </Form>
        ) : (
          loaderData.addable.length > 0 && (
            <Form
              // A fresh list after each change, back on "Pick a role".
              key={roles.map((r) => r.value).join()}
              method="post"
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="intent" value="grant" />
              <Field label="Add a role">
                <select name="role" className={input} defaultValue="">
                  <option value="" disabled>
                    Pick a role
                  </option>
                  {loaderData.addable.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className={btn.secondary}>
                Add
              </button>
            </Form>
          )
        )}
        {loaderData.viewerIsAdmin && (
          <Link to="/admin/roles" className="inline-block text-sm underline">
            What each role can do
          </Link>
        )}
      </div>

      {loaderData.can.campYears && (
        <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
          <h2 className="font-semibold">Camp years</h2>
          <input type="hidden" name="intent" value="camp_years" />
          <p className="text-sm text-charcoal">
            Which past burns they camped with us. Shown on Yearbook cards and in past Yearbooks.
          </p>
          <div className="grid grid-cols-3 gap-3">
            {campYears.map((y) => (
              <Field key={y.year} label={String(y.year)}>
                <select name={`year_${y.year}`} defaultValue={y.value} className={input}>
                  {(Object.keys(CAMP_YEAR_LABEL) as CampYearValue[]).map((v) => (
                    <option key={v} value={v}>
                      {CAMP_YEAR_LABEL[v]}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <button type="submit" className={btn.secondary}>
            Save camp years
          </button>
        </Form>
      )}

      <div className="rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="mb-2 font-semibold">History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-charcoal">Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id}>
                <span className="text-charcoal" suppressHydrationWarning>
                  {new Date(h.at).toLocaleString()}
                </span>{" "}
                · <span className={h.failed ? "text-coral-ink" : undefined}>{h.text}</span>
                <span className="text-charcoal">
                  {h.by.kind === "email" ? null : h.by.kind === "self" ? (
                    " · by them"
                  ) : h.by.kind === "person" ? (
                    <>
                      {" · by "}
                      <Link to={`/people/${h.by.id}`} className="underline">
                        {h.by.name}
                      </Link>
                    </>
                  ) : (
                    " · by the app"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {moreHistory && (
          <Link to="?history=all" className="mt-2 inline-block text-sm underline">
            Show all history
          </Link>
        )}
      </div>
    </section>
  );
}
