// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useSearchParams } from "react-router";
import { MailingAddressFields } from "~/components/MailingAddressFields";
import { PageText } from "~/components/PageText";
import { PhotoPicker } from "~/components/PhotoPicker";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { photoUrl } from "~/components/Yearbook";
import { person } from "~/db/schema";
import { getViewer } from "~/lib/access.server";
import { audit } from "~/lib/audit.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb, getSettings } from "~/lib/context.server";
import { directoryChoice, setDirectoryChoice } from "~/lib/data/directory.server";
import { campYears } from "~/lib/data/history.server";
import { pageTexts } from "~/lib/data/page-text.server";
import { currentYear } from "~/lib/data/participation.server";
import { requestEmailChange } from "~/lib/email-change.server";
import { formError } from "~/lib/errors";
import { leaveCamp } from "~/lib/leave-camp.server";
import { readMailingAddress } from "~/lib/mailing-address";
import {
  cardLabel,
  MAX_UPLOAD_BYTES,
  removePhoto,
  setPhoto,
  setShowFirstName,
} from "~/lib/photos.server";
import { readUpload } from "~/lib/upload.server";
import type { Route } from "./+types/_app.profile";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Your profile") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context);
  const { personId, support } = getViewer(context);
  // Support access (R39) isn't a person, so it has no profile.
  if (support) throw data({ reason: "not_found" }, { status: 404 });
  const [p] = await db
    .select({
      legalName: person.legalName,
      playaName: person.playaName,
      email: person.email,
      phone: person.phone,
      homeLocation: person.homeLocation,
      mailingAddress: person.mailingAddress,
      photoKey: person.photoKey,
      showFirstName: person.yearbookShowFirstName,
    })
    .from(person)
    .where(eq(person.id, personId));
  const texts = await pageTexts(db, ["profile_photo", "profile_email_hint"]);
  return {
    photoGuidance: texts.profile_photo,
    emailHint: texts.profile_email_hint,
    // Issue #78: the camp collects mailing addresses (Admin → Features).
    mailing: (await getSettings(context)).features.mailing,
    season: await currentYear(db),
    campYears: (await campYears(db, [personId])).get(personId) ?? [],
    directory: await directoryChoice(db, personId),
    profile: p,
    photoUrl: p.photoKey ? photoUrl(p.photoKey) : null,
    card: cardLabel({
      playaName: p.playaName,
      legalName: p.legalName,
      showFirstName: p.showFirstName,
    }),
  };
}

const SAVED: Record<string, string> = {
  details: "Saved.",
  photo:
    "Photo saved. It's in this year's Yearbook while you're Going or Leaning yes, and in past Yearbooks for years you camped.",
  photo_removed: "Photo removed.",
  first_name: "Yearbook name updated.",
  directory: "Directory choice saved.",
  email_sent:
    "Check your current inbox: we sent a link to approve the change. Then confirm it from the link we send to the new address. Until both are done, sign-in links still go to your current email.",
};

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = getViewer(context);
  const db = getDb(context);
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "details");

  try {
    if (intent === "photo_upload") {
      const file = form.get("photo");
      if (!(file instanceof File)) return { error: "Choose a photo first." };
      await setPhoto(
        db,
        env,
        context.get(cloudflareContext).camp.id,
        viewer.personId,
        await readUpload(file, MAX_UPLOAD_BYTES, "photo_too_large"),
      );
      return redirect("/profile?saved=photo");
    }
    if (intent === "photo_remove") {
      await removePhoto(db, env, viewer, viewer.personId);
      return redirect("/profile?saved=photo_removed");
    }
    if (intent === "directory") {
      await setDirectoryChoice(db, viewer.personId, form.get("share") === "yes");
      // The home-page card posts here too, and goes back home.
      return redirect(form.get("next") === "/" ? "/?saved=directory" : "/profile?saved=directory");
    }
    if (intent === "email_change") {
      await requestEmailChange(db, env, viewer.personId, String(form.get("newEmail") ?? ""));
      return redirect("/profile?saved=email_sent");
    }
    if (intent === "leave") {
      if (form.get("confirm") !== "on") return { error: "Tick the box to confirm you're leaving." };
      await leaveCamp(db, env, viewer);
      return redirect("/sign-in?left=1");
    }
    if (intent === "first_name") {
      await setShowFirstName(db, viewer.personId, form.get("showFirstName") === "on");
      return redirect("/profile?saved=first_name");
    }
  } catch (e) {
    return formError(e);
  }

  const text = (k: string, max = 120) =>
    String(form.get(k) ?? "")
      .trim()
      .slice(0, max) || null;
  const legalName = text("legalName");
  if (!legalName) return { error: "Your name is required." };
  // Only while the camp collects them; otherwise a saved address is left as it is.
  const mailing = (await getSettings(context)).features.mailing
    ? readMailingAddress((k) => String(form.get(k) ?? ""))
    : null;
  if (mailing && "problem" in mailing) return { error: mailing.problem };
  const next = {
    legalName,
    playaName: text("playaName"),
    phone: text("phone", 40),
    homeLocation: text("homeLocation"),
    ...(mailing ? { mailingAddress: mailing.address } : {}),
  };
  const [before] = await db.select().from(person).where(eq(person.id, viewer.personId));
  await db
    .update(person)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(person.id, viewer.personId));
  await audit(db, {
    actorPersonId: viewer.personId,
    action: "profile_updated",
    subjectType: "person",
    subjectId: viewer.personId,
    before: {
      legalName: before.legalName,
      playaName: before.playaName,
      phone: before.phone,
      homeLocation: before.homeLocation,
      ...(mailing ? { mailingAddress: before.mailingAddress } : {}),
    },
    after: next,
  });
  return redirect("/profile?saved=details");
}

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
  const { profile, photoUrl, card, campYears, directory } = loaderData;
  const [params] = useSearchParams();
  const saved = params.get("saved");
  return (
    <section className="max-w-lg space-y-6">
      <div>
        <Link to="/" className="inline-block text-sm underline pointer-coarse:py-2.5">
          ← Home
        </Link>
        <PageHeader title="Your profile">
          <Link to="/privacy-notice" className="text-sm underline">
            Who can see what
          </Link>
        </PageHeader>
        {saved && <Notice tone="ok">{SAVED[saved] ?? "Saved."}</Notice>}
        {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
      </div>

      <div className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Yearbook photo</h2>
        <p className="text-sm text-charcoal">
          <PageText text={loaderData.photoGuidance} year={loaderData.season} /> Your photo appears
          in the <strong>members-only Yearbook</strong> while you're Going or Leaning yes this year,
          and in past Yearbooks for years you camped. Members can see it (and could screenshot it).
          Remove it any time to leave the Yearbook. Past Yearbooks also list that year's campers
          without a photo, by the name below.
        </p>
        <p className="text-sm">
          <span className="font-medium">Your camp years: </span>
          <span className="text-charcoal">
            {campYears.length ? campYears.join(" · ") : "none recorded yet"}. Something missing?
            Tell a Lead.
          </span>
        </p>

        <div className="flex items-center gap-4">
          <div className="w-32 shrink-0 text-center">
            {photoUrl ? (
              <img
                src={photoUrl}
                alt="You, as shown in the Yearbook"
                className="h-32 w-32 rounded-xl object-cover ring-1 ring-dust"
              />
            ) : (
              <div className="flex h-32 w-32 items-center justify-center rounded-xl bg-dust-pale text-sm text-charcoal ring-1 ring-dust">
                No photo
              </div>
            )}
            <div className="mt-1 font-semibold">{card.label}</div>
            {card.secondary && <div className="text-sm text-charcoal">{card.secondary}</div>}
          </div>
          <p className="text-sm text-charcoal">
            This is exactly what your Yearbook card shows.
            {!profile.playaName &&
              " With no playa name, your first name is shown. Add a playa name below if you'd rather not."}
          </p>
        </div>

        <PhotoPicker hasPhoto={!!photoUrl} />

        {profile.playaName && (
          <Form method="post" className="flex flex-wrap items-center gap-3 text-sm">
            <input type="hidden" name="intent" value="first_name" />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="showFirstName" defaultChecked={profile.showFirstName} />
              Also show my first name under my playa name
            </label>
            <button type="submit" className={btn.secondary}>
              Save
            </button>
          </Form>
        )}

        {photoUrl && (
          <Form method="post">
            <input type="hidden" name="intent" value="photo_remove" />
            <button type="submit" className={btn.danger}>
              Remove my photo
            </button>
          </Form>
        )}
      </div>

      <Form method="post" className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Details</h2>
        <input type="hidden" name="intent" value="details" />
        <Field label="Name">
          <input
            name="legalName"
            defaultValue={profile.legalName}
            required
            className={input}
            autoComplete="name"
          />
        </Field>
        <Field label="Playa name">
          <input name="playaName" defaultValue={profile.playaName ?? ""} className={input} />
        </Field>
        <Field label="Phone">
          <input
            name="phone"
            type="tel"
            defaultValue={profile.phone ?? ""}
            className={input}
            autoComplete="tel"
          />
        </Field>
        <Field
          label="Home location"
          hint="City is plenty. Other members see it in the Yearbook and directory."
        >
          <input name="homeLocation" defaultValue={profile.homeLocation ?? ""} className={input} />
        </Field>
        {loaderData.mailing && (
          <fieldset className="space-y-3 border-t border-dust-light pt-4">
            <legend className="font-semibold">
              Mailing address <span className="font-normal text-charcoal">(optional)</span>
            </legend>
            <p className="text-sm text-charcoal">
              So the camp can post you something. Only the camp's Leads and Admins see it, never
              other members.
            </p>
            <MailingAddressFields value={profile.mailingAddress} />
          </fieldset>
        )}
        <button type="submit" className={btn.primary}>
          Save
        </button>
      </Form>

      <Form
        method="post"
        id="directory"
        className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light"
      >
        <h2 className="font-semibold">Camp directory</h2>
        <input type="hidden" name="intent" value="directory" />
        <p className="text-sm text-charcoal">
          The directory lists everyone Going or Leaning yes this year, so campers can reach each
          other. It always shows your Yearbook name and home location. Sharing adds your full name,
          email and phone. Leads can always see your contact details.
        </p>
        <fieldset className="space-y-1 text-sm">
          <legend className="sr-only">Share your contact details?</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="share" value="yes" defaultChecked={directory.sharing} />
            Share my name, email and phone with campers
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="share" value="no" defaultChecked={!directory.sharing} />
            Keep them hidden
          </label>
        </fieldset>
        <button type="submit" className={btn.secondary}>
          Save
        </button>
      </Form>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Sign-in email</h2>
        {loaderData.emailHint && (
          <p className="rounded-lg bg-gold-glow p-3 text-sm">
            <PageText text={loaderData.emailHint} year={loaderData.season} />
          </p>
        )}
        <p className="text-sm text-charcoal">
          {`Sign-in links go to ${profile.email ?? "your current email"}. To use a different address, enter it below. You'll approve the change from your current address, then confirm it from the new one, and you'll be signed out everywhere once it's done. It's the email you sign in with at every camp you belong to. If you can't get into your current mailbox, ask a camp lead to help.`}
        </p>
        <input type="hidden" name="intent" value="email_change" />
        <Field label="New email">
          <input name="newEmail" type="email" required autoComplete="email" className={input} />
        </Field>
        <button type="submit" className={btn.secondary}>
          Send approval link
        </button>
      </Form>

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Leave this camp</h2>
        <p className="text-sm text-charcoal">
          You'll be signed out and won't be able to sign in here again. Your photo is deleted and
          you leave the directory. A camp lead can invite you back later. Other camps you belong to
          aren't affected.
        </p>
        <input type="hidden" name="intent" value="leave" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" required />I understand, and I want to leave
        </label>
        <button type="submit" className={btn.secondary}>
          Leave this camp
        </button>
      </Form>
    </section>
  );
}
