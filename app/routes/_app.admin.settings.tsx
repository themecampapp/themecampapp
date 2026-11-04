// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { btn, Field, fileInput, input, Notice, PageHeader } from "~/components/ui";
import { getViewer } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { cloudflareContext, getDb } from "~/lib/context.server";
import { getCampSettings, saveCampSettings } from "~/lib/data/camp-settings.server";
import { methodLabel } from "~/lib/dues";
import { formError } from "~/lib/errors";
import { fileName } from "~/lib/files.server";
import { MAX_LOGO_BYTES, removeLogo, setLogo } from "~/lib/logo.server";
import { readUpload } from "~/lib/upload.server";
import type { Route } from "./+types/_app.admin.settings";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Camp settings · Admin") }];
}

// The camp's name, logo, colour, contact and join-page text, who hears about new inquiries, the
// ticket limit and the dues payment methods (R19, R22). Admins only, via the admin layout.
export async function loader({ context }: Route.LoaderArgs) {
  const s = await getCampSettings(getDb(context));
  return {
    name: s.name,
    accent: s.accent ?? "",
    contactEmail: s.contactEmail ?? "",
    inquiryNotify: s.inquiryNotify.join("\n"),
    maxTickets: s.maxTickets,
    paymentMethods: s.paymentMethods.map(methodLabel).join("\n"),
    logoUrl: s.logoKey ? `/logo/${fileName(s.logoKey)}` : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const done = (msg: string) => redirect(`/admin/settings?notice=${encodeURIComponent(msg)}`);
  const { env, camp } = context.get(cloudflareContext);
  try {
    if (get("intent") === "logo_upload") {
      const file = form.get("logo");
      if (!(file instanceof File) || file.size === 0)
        return { error: "Choose a logo image first." };
      await setLogo(
        getDb(context),
        env,
        camp.id,
        getViewer(context),
        await readUpload(file, MAX_LOGO_BYTES, "logo_too_large"),
      );
      return done("Logo saved.");
    }
    if (get("intent") === "logo_remove") {
      await removeLogo(getDb(context), env, getViewer(context));
      return done("Logo removed.");
    }
    await saveCampSettings(getDb(context), getViewer(context), {
      name: get("name"),
      accent: get("accent"),
      contactEmail: get("contactEmail"),
      inquiryNotify: get("inquiryNotify"),
      maxTickets: get("maxTickets"),
      paymentMethods: get("paymentMethods"),
    });
  } catch (e) {
    return formError(e);
  }
  return done("Settings saved.");
}

export default function CampSettings({ loaderData: s, actionData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return (
    <section className="max-w-2xl space-y-5">
      <PageHeader title="Camp settings" />
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Logo</h2>
        <p className="text-sm text-charcoal">
          Shown in the header next to the camp's name. A JPEG, PNG, WebP or HEIC image up to 2 MB;
          it's resized to fit 400 by 120 pixels. A transparent PNG works best.
        </p>
        {s.logoUrl && (
          <div className="flex items-center gap-3">
            <img src={s.logoUrl} alt="The camp's logo" className="h-12 w-auto max-w-60" />
            <Form method="post">
              <input type="hidden" name="intent" value="logo_remove" />
              <button type="submit" className={btn.secondary}>
                Remove logo
              </button>
            </Form>
          </div>
        )}
        <Form
          method="post"
          encType="multipart/form-data"
          className="flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="intent" value="logo_upload" />
          <input
            type="file"
            name="logo"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            aria-label="Logo image"
            className={fileInput}
          />
          <button type="submit" className={btn.secondary}>
            {s.logoUrl ? "Replace logo" : "Upload logo"}
          </button>
        </Form>
      </div>
      <Form method="post" className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}
        <Field label="Camp name" hint="Shown in the header, page titles and emails.">
          <input name="name" defaultValue={s.name} maxLength={60} required className={input} />
        </Field>
        <Field
          label="Accent colour (optional)"
          hint="A hex code like #9db4cc. It needs to be light enough for dark text to read on it."
        >
          <div className="flex items-center gap-2">
            <input
              name="accent"
              defaultValue={s.accent}
              placeholder="#9db4cc"
              className={`${input} w-36`}
            />
            {s.accent && (
              <span
                aria-hidden
                className="inline-block h-8 w-8 rounded-full ring-1 ring-dust"
                style={{ background: s.accent }}
              />
            )}
          </div>
        </Field>
        <Field
          label="Contact email (optional)"
          hint="Where campers can reach the camp's organizers."
        >
          <input name="contactEmail" type="email" defaultValue={s.contactEmail} className={input} />
        </Field>
        <p className="text-sm text-charcoal">
          {"The join page's introduction and other instructions members see are under "}
          <Link to="/admin/wording" className="underline">
            Page wording
          </Link>
          .
        </p>
        <Field
          label="Tell these people about new inquiries"
          hint="One email address per line, up to 10. The email says only that someone asked."
        >
          <textarea
            name="inquiryNotify"
            rows={3}
            defaultValue={s.inquiryNotify}
            className={input}
          />
        </Field>
        <Field label="Most tickets a camper can request" hint="From 1 to 10.">
          <input
            name="maxTickets"
            type="number"
            min={1}
            max={10}
            defaultValue={s.maxTickets}
            className={`${input} w-24`}
          />
        </Field>
        <Field
          label="Dues payment methods"
          hint="One per line, e.g. Venmo. The Treasurer picks from these. The app never takes payments."
        >
          <textarea
            name="paymentMethods"
            rows={4}
            defaultValue={s.paymentMethods}
            className={input}
          />
        </Field>
        <button type="submit" className={btn.primary}>
          Save settings
        </button>
      </Form>
    </section>
  );
}
