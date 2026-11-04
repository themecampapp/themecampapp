// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The instance's legal pages (open-source plan 3.6): Markdown in legal/<dir>/, where <dir> is
// the instance config's legal.dir (the LEGAL_DIR var). The hosted service's own documents are in
// legal/hosted; legal/templates are examples for self-hosters. Every folder is bundled, and the
// instance's is picked at runtime. {product}, {operator} and {contact} are filled in from config.

import { type FeaturesEnv, featureOn, type InstanceFeature } from "./instance-features";

const files = import.meta.glob("../../legal/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const LEGAL_DOCS = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
  "data-handling": "How we handle data",
  "pilot-agreement": "Pilot agreement",
} as const;
export type LegalDoc = keyof typeof LEGAL_DOCS;

type LegalEnv = FeaturesEnv & {
  LEGAL_DIR?: string;
  PILOT_AGREEMENT?: string;
  PRODUCT_NAME?: string;
  OPERATOR_NAME?: string;
  CONTACT_EMAIL?: string;
};

// Whether new camps' Admins must accept the pilot agreement (config legal.pilotAgreement).
export const pilotAgreementOn = (env: LegalEnv) => env.PILOT_AGREEMENT === "true";

// The documents this instance publishes: the pilot agreement only when it applies.
export const legalDocs = (env: LegalEnv) =>
  (Object.keys(LEGAL_DOCS) as LegalDoc[]).filter(
    (d) => d !== "pilot-agreement" || pilotAgreementOn(env),
  );

// A document's text with the instance's details filled in, or null if this instance doesn't
// publish it (or its folder lacks it).
export function legalText(env: LegalEnv, doc: string, contact = env.CONTACT_EMAIL ?? "") {
  if (!(legalDocs(env) as string[]).includes(doc)) return null;
  const text = env.LEGAL_DIR ? files[`../../legal/${env.LEGAL_DIR}/${doc}.md`] : undefined;
  if (text === undefined) return null;
  return withFeatures(env, text)
    .replaceAll("{contact}", contact)
    .replaceAll("{product}", env.PRODUCT_NAME ?? "")
    .replaceAll("{operator}", env.OPERATOR_NAME ?? "");
}

// A line ending in {feature:<name>} is about one of the hosted-only features (open-source plan
// 3.7): it's kept, without the tag, only when the instance has that feature on.
const FEATURE_TAG = / ?\{feature:([a-zA-Z]+)\}\s*$/;
function withFeatures(env: LegalEnv, text: string) {
  return text
    .split("\n")
    .flatMap((line) => {
      const m = line.match(FEATURE_TAG);
      if (!m) return [line];
      return featureOn(env, m[1] as InstanceFeature) ? [line.replace(FEATURE_TAG, "")] : [];
    })
    .join("\n");
}
