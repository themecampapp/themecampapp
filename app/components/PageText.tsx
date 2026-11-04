// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCamp } from "~/lib/camp";
import { fillPageText } from "~/lib/page-text";
import { LinkedText } from "./LinkedText";

// A camp's page wording (app/lib/page-text.ts), with {camp} and {year} filled in and full
// https:// addresses shown as links. Nothing is rendered as HTML.
export function PageText({ text, year }: { text: string; year: number }) {
  const { campName } = useCamp();
  return <LinkedText text={fillPageText(text, { camp: campName, year })} />;
}
