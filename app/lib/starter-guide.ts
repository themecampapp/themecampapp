// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { GUIDE_VISIBILITIES } from "~/db/schema";

// One starter guide file (content/starter-guides/*.md), read without Vite so the demo seed
// script can use it too.

export type Starter = {
  slug: string;
  title: string;
  summary: string;
  visibility: (typeof GUIDE_VISIBILITIES)[number];
  body: string;
};

// "---\nkey: value\n---\nbody": the few keys a starter has, nothing more.
export function parseStarter(file: string, text: string): Starter {
  const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(text.replace(/\r\n?/g, "\n"));
  if (!m) throw new Error(`${file}: no front matter`);
  const meta = Object.fromEntries(
    m[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  if (
    !meta.slug ||
    !meta.title ||
    !(GUIDE_VISIBILITIES as readonly string[]).includes(meta.visibility)
  ) {
    throw new Error(`${file}: needs slug, title and visibility`);
  }
  return {
    slug: meta.slug,
    title: meta.title,
    summary: meta.summary ?? "",
    visibility: meta.visibility as Starter["visibility"],
    body: m[2].trimEnd(),
  };
}
