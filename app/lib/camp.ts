// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRouteLoaderData } from "react-router";

// The camp's name and accent, loaded by the root route for every page.
export type CampInfo = {
  campName: string;
  // The instance's name (config product.name, open-source plan 3.5), e.g. "Theme Camp App".
  productName: string;
  accent: string | null;
  logoUrl: string | null;
  // The instance's public site (Terms, Privacy Policy): https://<platform domain>, or "" when
  // unknown.
  legalBase: string;
  // Where the instance's source code is (config product.sourceUrl; the AGPL's section 13), or ""
  // when unknown.
  sourceUrl: string;
};

export function useCamp(): CampInfo {
  return (
    (useRouteLoaderData("root") as CampInfo | undefined) ?? {
      // Only when the root loader didn't run (an error before it).
      campName: "",
      productName: "",
      accent: null,
      logoUrl: null,
      // Only when the root loader didn't run (an error before it): no links to a guessed site.
      legalBase: "",
      sourceUrl: "",
    }
  );
}

// "<page> · <camp>", from the root loader's data in a meta() function.
export function pageTitle(
  matches: ReadonlyArray<{ id: string; loaderData?: unknown } | undefined>,
  page?: string,
) {
  const root = matches.find((m) => m?.id === "root")?.loaderData as CampInfo | undefined;
  const camp = root?.campName || root?.productName || "";
  return page && camp ? `${page} · ${camp}` : page || camp;
}

// The three shades the app uses, from a camp's accent (app/app.css has the defaults; app/root.tsx applies them).
export const accentPalette = (accent: string) => ({
  "--color-gold": accent,
  "--color-gold-light": `color-mix(in srgb, ${accent} 65%, white)`,
  "--color-gold-glow": `color-mix(in srgb, ${accent} 22%, white)`,
});
