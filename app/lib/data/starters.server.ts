// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseStarter, type Starter } from "../starter-guide";

// R30: the starter guide library (content/starter-guides). General versions of the guides a
// camp needs, which its Leads copy as drafts and then make their own. Each keeps the address
// the app's pages link to (GuideLink), so copying one lights up those links once published.

export type { Starter };

const files = import.meta.glob("../../../content/starter-guides/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// In the order a new camp most needs them.
const ORDER = [
  "welcome",
  "tickets-stewards-sale",
  "arrival-build-strike",
  "dues",
  "sap",
  "volunteer",
  "lead-handbook",
];

export const STARTERS: Starter[] = Object.entries(files)
  .map(([file, text]) => parseStarter(file, text))
  .sort((a, b) => ORDER.indexOf(a.slug) - ORDER.indexOf(b.slug));

export const findStarter = (slug: string) => STARTERS.find((s) => s.slug === slug) ?? null;
