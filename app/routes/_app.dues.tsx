// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Form, Link, redirect, useSearchParams } from "react-router";
import { GuideLink } from "~/components/GuideLink";
import { btn, Field, input, Notice, PageHeader } from "~/components/ui";
import { requireAccess } from "~/lib/access.server";
import { pageTitle } from "~/lib/camp";
import { getDb, getSettings } from "~/lib/context.server";
import {
  duesBoard,
  getDuesSettings,
  isUnpaid,
  recordDues,
  removeDuesTier,
  saveDuesTier,
  setDuesSettings,
  summarizeDues,
} from "~/lib/data/dues.server";
import { type DuesStatus, formatCents, methodLabel } from "~/lib/dues";
import { formError } from "~/lib/errors";
import type { Route } from "./+types/_app.dues";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: pageTitle(matches, "Dues") }];
}

const VIEWS = ["unpaid", "paid", "waived", "all"] as const;
type View = (typeof VIEWS)[number];

const STATUS_LABEL: Record<DuesStatus, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  waived: "Waived",
};

// Dues only (issue #93; the Treasurer by default): who has paid is private (issue #2). The
// _app middleware checks the same; writes are checked again in the data layer.
export async function loader({ request, context }: Route.LoaderArgs) {
  requireAccess(context, "dues");
  const db = getDb(context);
  const param = new URL(request.url).searchParams.get("view");
  const view: View = VIEWS.includes(param as View) ? (param as View) : "unpaid";
  const rows = await duesBoard(db);
  const shown = rows.filter((r) =>
    view === "all" ? true : view === "unpaid" ? isUnpaid(r) : r.status === view,
  );
  return {
    view,
    settings: await getDuesSettings(db),
    methods: (await getSettings(context)).paymentMethods,
    summary: summarizeDues(rows),
    // How many campers are on each tier, for the tiers list.
    onTier: rows.reduce<Record<string, number>>((n, r) => {
      if (r.tierId) n[r.tierId] = (n[r.tierId] ?? 0) + 1;
      return n;
    }, {}),
    today: new Date().toISOString().slice(0, 10),
    // Flagged rows (plans changed after paying) float to the top.
    rows: [...shown].sort((a, b) => Number(b.flagged) - Number(a.flagged)),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const viewer = requireAccess(context, "dues", "manage");
  const db = getDb(context);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");
  const back = (msg: string) =>
    redirect(
      `/dues?view=${encodeURIComponent(field("view") || "unpaid")}&notice=${encodeURIComponent(msg)}`,
    );
  try {
    if (field("intent") === "settings") {
      await setDuesSettings(db, viewer, {
        amount: field("amount"),
        instructions: field("instructions"),
      });
      return back("Dues settings saved.");
    }
    if (field("intent") === "tier_save") {
      await saveDuesTier(db, viewer, {
        id: field("tierId") || undefined,
        name: field("tierName"),
        amount: field("amount"),
      });
      return back(`Saved the ${field("tierName").trim()} tier.`);
    }
    if (field("intent") === "tier_remove") {
      const { name, moved } = await removeDuesTier(db, viewer, field("tierId"));
      return back(
        moved
          ? `Removed the ${name} tier. ${moved} ${moved === 1 ? "camper is" : "campers are"} back on the standard amount.`
          : `Removed the ${name} tier.`,
      );
    }
    await recordDues(db, viewer, field("personId"), {
      status: field("status"),
      tier: form.has("tier") ? field("tier") : undefined,
      amount: field("amount"),
      paidOn: field("paidOn"),
      method: field("method"),
    });
    return back(`Saved ${field("name") || "dues"}.`);
  } catch (e) {
    return formError(e);
  }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-dust-light">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm text-charcoal">{label}</div>
    </div>
  );
}

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

type Tier = { id: string; name: string; amountCents: number };

// Named amounts besides the standard one (issue #63), e.g. "Low income" or "Kitchen lead".
// Campers are put on a tier from their row below; nobody else sees who is on which.
function Tiers({
  tiers,
  onTier,
  view,
}: {
  tiers: Tier[];
  onTier: Record<string, number>;
  view: string;
}) {
  return (
    <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
      <div>
        <h2 className="font-semibold">Dues tiers</h2>
        <p className="text-sm text-charcoal">
          Other amounts, like need-based dues or a lower amount for some Leads. Put campers on a
          tier from their row below. Only you and the camper see their tier.
        </p>
      </div>
      {tiers.length > 0 && (
        <ul className="space-y-2">
          {tiers.map((t) => (
            <li key={t.id}>
              <Form method="post" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="tierId" value={t.id} />
                <input type="hidden" name="view" value={view} />
                <Field label="Tier name">
                  <input
                    name="tierName"
                    defaultValue={t.name}
                    maxLength={60}
                    required
                    className={`${input} w-48`}
                  />
                </Field>
                <Field label="Amount ($)">
                  <input
                    name="amount"
                    inputMode="decimal"
                    defaultValue={dollars(t.amountCents)}
                    required
                    className={`${input} w-24`}
                  />
                </Field>
                <span className="pb-2 text-sm text-charcoal">{`${onTier[t.id] ?? 0} on it`}</span>
                <button type="submit" name="intent" value="tier_save" className={btn.secondary}>
                  Save
                </button>
                <button type="submit" name="intent" value="tier_remove" className={btn.secondary}>
                  Remove
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="tier_save" />
        <input type="hidden" name="view" value={view} />
        <Field label="New tier">
          <input
            name="tierName"
            placeholder="e.g. Low income"
            maxLength={60}
            required
            className={`${input} w-48`}
          />
        </Field>
        <Field label="Amount ($)">
          <input name="amount" inputMode="decimal" required className={`${input} w-24`} />
        </Field>
        <button type="submit" className={btn.secondary}>
          Add tier
        </button>
      </Form>
    </div>
  );
}

export default function Dues({ loaderData, actionData }: Route.ComponentProps) {
  const { view, settings, methods, summary, rows, today, onTier } = loaderData;
  const [params] = useSearchParams();
  const tabs: Array<{ view: View; label: string; count?: number }> = [
    { view: "unpaid", label: "Unpaid", count: summary.unpaid },
    { view: "paid", label: "Paid", count: summary.paid },
    { view: "waived", label: "Waived", count: summary.waived },
    { view: "all", label: "Everyone" },
  ];

  return (
    <section className="space-y-5">
      <PageHeader title={`${settings.year} dues`}>
        <GuideLink slug="dues" className={btn.secondary}>
          Dues guide
        </GuideLink>
      </PageHeader>
      {params.get("notice") && <Notice tone="ok">{params.get("notice")}</Notice>}
      {actionData?.error && <Notice tone="error">{actionData.error}</Notice>}

      <Form method="post" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-dust-light">
        <h2 className="font-semibold">Amount and how to pay</h2>
        <input type="hidden" name="intent" value="settings" />
        <input type="hidden" name="view" value={view} />
        <Field
          label="Standard dues ($)"
          hint="What each camper owes unless you put them on a tier below. Leave blank until it's decided."
        >
          <input
            name="amount"
            inputMode="decimal"
            defaultValue={dollars(settings.amountCents)}
            className={`${input} w-32`}
          />
        </Field>
        <Field
          label="Payment instructions"
          hint="Shown to every camper who owes dues, e.g. a Venmo handle."
        >
          <textarea
            name="instructions"
            rows={3}
            maxLength={1000}
            defaultValue={settings.instructions ?? ""}
            className={input}
          />
        </Field>
        <button type="submit" className={btn.secondary}>
          Save
        </button>
      </Form>

      <Tiers tiers={settings.tiers} onTier={onTier} view={view} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Unpaid" value={summary.unpaid} />
        <Stat label="Paid" value={summary.paid} />
        <Stat label="Waived" value={summary.waived} />
        <Stat label="Collected" value={formatCents(summary.collectedCents)} />
      </div>
      {summary.flagged > 0 && (
        <Notice>
          {`${summary.flagged} ${summary.flagged === 1 ? "camper has" : "campers have"} changed plans since paying. They're at the top of the list; saving their row clears the flag.`}
        </Notice>
      )}

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Dues views">
        {tabs.map((t) => (
          <Link
            key={t.view}
            to={`?view=${t.view}`}
            className={`rounded-full px-3 py-1 ring-1 pointer-coarse:py-2.5 ${view === t.view ? "bg-night text-warm-white ring-night" : "bg-white ring-dust"}`}
          >
            {t.label}
            {t.count !== undefined && <span className="ml-1 opacity-70">{t.count}</span>}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-sm text-charcoal">No one here.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.personId} className="rounded-xl bg-white p-3 ring-1 ring-dust-light">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span>
                  <span className="font-medium">{r.name}</span>
                  {r.name !== r.legalName && (
                    <span className="ml-2 text-sm text-charcoal">{r.legalName}</span>
                  )}
                </span>
                <span className="text-sm">
                  {r.flagged && (
                    <span className="mr-2 rounded-full bg-coral/10 px-2 py-0.5 text-coral-ink">
                      Plans changed
                    </span>
                  )}
                  <span className="font-medium">{STATUS_LABEL[r.status]}</span>
                  {r.tierName && <span className="text-charcoal">{` · ${r.tierName}`}</span>}
                  {r.status === "unpaid" && r.owedCents !== null && (
                    <span className="text-charcoal">{` · owes ${formatCents(r.owedCents)}`}</span>
                  )}
                  {r.status === "paid" && (
                    <span className="text-charcoal">
                      {` · ${formatCents(r.amountCents ?? 0)} · ${r.paidOn ?? ""} · ${methodLabel(r.method ?? "other")}`}
                    </span>
                  )}
                  {r.recordedBy && (
                    <span className="text-charcoal">{` · recorded by ${r.recordedBy}`}</span>
                  )}
                </span>
              </div>
              <Form method="post" className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="personId" value={r.personId} />
                <input type="hidden" name="name" value={r.name} />
                <input type="hidden" name="view" value={view} />
                <Field label="Status">
                  <select name="status" defaultValue={r.status} className={`${input} w-28`}>
                    {(Object.keys(STATUS_LABEL) as DuesStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                {settings.tiers.length > 0 && (
                  <Field label="Tier">
                    <select name="tier" defaultValue={r.tierId ?? ""} className={`${input} w-44`}>
                      <option value="">
                        {settings.amountCents === null
                          ? "Standard"
                          : `Standard (${formatCents(settings.amountCents)})`}
                      </option>
                      {settings.tiers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {`${t.name} (${formatCents(t.amountCents)})`}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Amount ($)">
                  {/* Left blank, a payment is recorded at what they owe on their tier. */}
                  <input
                    name="amount"
                    inputMode="decimal"
                    defaultValue={dollars(r.amountCents)}
                    placeholder={dollars(r.owedCents)}
                    className={`${input} w-24`}
                  />
                </Field>
                <Field label="Paid on">
                  <input
                    name="paidOn"
                    type="date"
                    defaultValue={r.paidOn ?? today}
                    className={`${input} w-40`}
                  />
                </Field>
                <Field label="Method">
                  <select
                    name="method"
                    defaultValue={r.method && methods.includes(r.method) ? r.method : methods[0]}
                    className={`${input} w-28`}
                  >
                    {methods.map((m) => (
                      <option key={m} value={m}>
                        {methodLabel(m)}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="submit" className={btn.secondary}>
                  Save
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
