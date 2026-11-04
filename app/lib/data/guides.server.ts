// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { data } from "react-router";
import { campSettings, GUIDE_VISIBILITIES, guide } from "~/db/schema";
import { assertAccess, type Viewer } from "../access.server";
import { audit } from "../audit.server";
import type { Db } from "../db.server";
import { BODY_MAX, SUMMARY_MAX, TITLE_MAX } from "../guides";
import { renderMarkdown } from "../markdown.server";
import { findStarter } from "./starters.server";

// A camp's guides (R28, R29), stored per camp and edited by its Leads and Admins. Everything
// outside the editor sees published guides only, filtered by what the reader may see.

export type Visibility = (typeof GUIDE_VISIBILITIES)[number];
export type GuideAccess = { member: boolean; lead: boolean };

export const canRead = (visibility: Visibility, access: GuideAccess) =>
  visibility === "public" ||
  (visibility === "members" && access.member) ||
  (visibility === "leads" && access.member && access.lead);

const readable = (access: GuideAccess): Visibility[] =>
  GUIDE_VISIBILITIES.filter((v) => canRead(v, access));

export type GuideSummary = {
  slug: string;
  title: string;
  summary: string;
  visibility: Visibility;
};

// Published guides this reader may see, in the camp's order.
export async function listGuides(db: Db, access: GuideAccess): Promise<GuideSummary[]> {
  return db
    .select({
      slug: guide.slug,
      title: guide.title,
      summary: guide.summary,
      visibility: guide.visibility,
    })
    .from(guide)
    .where(and(eq(guide.published, true), inArray(guide.visibility, readable(access))))
    .orderBy(asc(guide.sort), asc(guide.title));
}

// A published guide by slug, with its visibility (so the page can decide what to do), or null.
export async function findGuide(db: Db, slug: string) {
  const [g] = await db
    .select()
    .from(guide)
    .where(and(eq(guide.slug, slug), eq(guide.published, true)));
  return g ?? null;
}

export const renderGuide = (body: string) => renderMarkdown(body);

// ---- Editing (Leads and Admins) ------------------------------------------------------------

const refuse = (reason: string, status = 400) => data({ reason }, { status });
const notFound = () => refuse("guide_not_found", 404);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A guide id from a form: a malformed one is simply not found (never a database error).
function checkId(id: string) {
  if (!ID_RE.test(id)) throw notFound();
}

function assertLead(actor: Viewer) {
  assertAccess(actor, "guides");
}

export function slugify(title: string) {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "guide"
  );
}

export async function editorList(db: Db) {
  return db
    .select({
      id: guide.id,
      slug: guide.slug,
      title: guide.title,
      visibility: guide.visibility,
      published: guide.published,
      updatedAt: guide.updatedAt,
    })
    .from(guide)
    .orderBy(asc(guide.sort), asc(guide.title));
}

export async function editorGuide(db: Db, id: string) {
  if (!ID_RE.test(id)) return null;
  const [g] = await db.select().from(guide).where(eq(guide.id, id));
  return g ?? null;
}

export type GuideInput = { title: string; summary: string; body: string; visibility: string };

function clean(input: GuideInput) {
  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title) throw refuse("guide_title_needed");
  if (title.length > TITLE_MAX) throw refuse("guide_title_too_long");
  const summary = input.summary.trim().replace(/\s+/g, " ");
  if (summary.length > SUMMARY_MAX) throw refuse("guide_summary_too_long");
  const body = input.body.replace(/\r\n?/g, "\n");
  if (body.length > BODY_MAX) throw refuse("guide_body_too_long");
  if (!GUIDE_VISIBILITIES.includes(input.visibility as Visibility)) {
    throw refuse("guide_visibility_needed");
  }
  return { title, summary, body, visibility: input.visibility as Visibility };
}

// A new guide starts as a draft at the end of the list. Its slug comes from the title, made
// unique within the camp.
export async function createGuide(db: Db, actor: Viewer, input: GuideInput) {
  assertLead(actor);
  const values = clean(input);
  return db.transaction(async (tx) => {
    // One create at a time per camp (the camp's settings row is the lock), so two drafts with
    // the same title get "x" and "x-2", never a unique-violation error.
    await tx.select({ id: campSettings.campId }).from(campSettings).for("update");
    const base = slugify(values.title);
    const taken = new Set(
      (
        await tx
          .select({ slug: guide.slug })
          .from(guide)
          .where(sql`${guide.slug} = ${base} or ${guide.slug} ~ ${`^${base}-[0-9]+$`}`)
      ).map((r) => r.slug),
    );
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${guide.sort}), 0) + 1` })
      .from(guide);
    const [row] = await tx
      .insert(guide)
      .values({ ...values, slug, sort: Number(next), updatedByPersonId: actor.personId })
      .returning({ id: guide.id, slug: guide.slug });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "guide_created",
      subjectType: "guide",
      subjectId: row.id,
      after: { title: values.title, slug, visibility: values.visibility },
    });
    return row;
  });
}

// R30: a starter guide copied into this camp as a draft, at the starter's own address. A camp
// that already has a guide there keeps it: copying again is refused. `product` (the instance's
// name) fills the starters' {product}, since a copied guide is the camp's own text from then on.
export async function copyStarter(db: Db, actor: Viewer, slug: string, product: string) {
  assertLead(actor);
  const starter = findStarter(slug);
  if (!starter) throw notFound();
  return db.transaction(async (tx) => {
    await tx.select({ id: campSettings.campId }).from(campSettings).for("update");
    const [taken] = await tx.select({ id: guide.id }).from(guide).where(eq(guide.slug, slug));
    if (taken) throw refuse("starter_already_copied", 409);
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${guide.sort}), 0) + 1` })
      .from(guide);
    const [row] = await tx
      .insert(guide)
      .values({
        slug,
        title: starter.title,
        summary: starter.summary,
        body: starter.body.replaceAll("{product}", product),
        visibility: starter.visibility,
        sort: Number(next),
        updatedByPersonId: actor.personId,
      })
      .returning({ id: guide.id });
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "guide_created",
      subjectType: "guide",
      subjectId: row.id,
      after: { title: starter.title, slug, visibility: starter.visibility, starter: slug },
    });
    return row;
  });
}

export async function saveGuide(db: Db, actor: Viewer, id: string, input: GuideInput) {
  assertLead(actor);
  checkId(id);
  const values = clean(input);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(guide).where(eq(guide.id, id)).for("update");
    if (!before) throw notFound();
    await tx
      .update(guide)
      .set({ ...values, updatedByPersonId: actor.personId, updatedAt: new Date() })
      .where(eq(guide.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "guide_saved",
      subjectType: "guide",
      subjectId: id,
      // The wording itself isn't copied into the log; what changed is.
      before: {
        title: before.title,
        visibility: before.visibility,
        summaryChanged: before.summary !== values.summary,
        bodyChanged: before.body !== values.body,
      },
      after: { title: values.title, visibility: values.visibility },
    });
  });
}

export async function setPublished(db: Db, actor: Viewer, id: string, published: boolean) {
  assertLead(actor);
  checkId(id);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(guide).where(eq(guide.id, id)).for("update");
    if (!before) throw notFound();
    if (before.published === published) return;
    await tx
      .update(guide)
      .set({
        published,
        publishedAt: published ? new Date() : before.publishedAt,
        updatedByPersonId: actor.personId,
        updatedAt: new Date(),
      })
      .where(eq(guide.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: published ? "guide_published" : "guide_unpublished",
      subjectType: "guide",
      subjectId: id,
      after: { title: before.title, visibility: before.visibility },
    });
  });
}

// Swaps a guide with its neighbour above or below.
export async function moveGuide(db: Db, actor: Viewer, id: string, direction: "up" | "down") {
  assertLead(actor);
  checkId(id);
  await db.transaction(async (tx) => {
    const all = await tx
      .select({ id: guide.id, sort: guide.sort, title: guide.title })
      .from(guide)
      .orderBy(asc(guide.sort), asc(guide.title))
      .for("update");
    const i = all.findIndex((g) => g.id === id);
    if (i === -1) throw notFound();
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    // Renumber so equal sorts can't make the order ambiguous.
    for (const [n, g] of all.entries()) {
      if (g.sort !== n + 1)
        await tx
          .update(guide)
          .set({ sort: n + 1 })
          .where(eq(guide.id, g.id));
    }
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "guides_reordered",
      subjectType: "guide",
      subjectId: id,
      after: { title: all[j].title, direction },
    });
  });
}

export async function deleteGuide(db: Db, actor: Viewer, id: string) {
  assertLead(actor);
  checkId(id);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(guide).where(eq(guide.id, id)).for("update");
    if (!before) throw notFound();
    if (before.published) throw refuse("guide_unpublish_first", 409);
    await tx.delete(guide).where(eq(guide.id, id));
    await audit(tx, {
      actorPersonId: actor.personId,
      action: "guide_deleted",
      subjectType: "guide",
      subjectId: id,
      before: { title: before.title, slug: before.slug },
    });
  });
}

// The slugs of published guides this reader may see, for links from other pages (a camp
// may not have a "dues" guide, so the Dues page only links to one that exists).
export async function guideSlugs(db: Db, access: GuideAccess): Promise<string[]> {
  const rows = await db
    .select({ slug: guide.slug })
    .from(guide)
    .where(and(eq(guide.published, true), inArray(guide.visibility, readable(access))));
  return rows.map((r) => r.slug);
}
