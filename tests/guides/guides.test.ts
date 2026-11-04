// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, guide, memberRole, person } from "~/db/schema";
import { APP_HOST_SUFFIX } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, ZULU_SLUG, type Zulu } from "../helpers/two-camps";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

// Guides are each camp's own, written in the app (R28) and rendered safely (R29).

let t: TestDb;
let w: TestWorker;
let z: Zulu;
let member: string;
let lead: string;
let admin: string;

const TEXT = {
  welcome: "Welcome-guide-opening-words",
  members: "Members-guide-secret-words",
  leads: "Leads-handbook-secret-words",
  draft: "Draft-guide-unpublished-words",
  bravo: "Bravo-camp-public-guide-words",
};
const ZULU_BASE = `https://${ZULU_SLUG}.${APP_HOST_SUFFIX}`;

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  await t.db.insert(guide).values([
    {
      slug: "welcome",
      title: "Welcome",
      body: TEXT.welcome,
      visibility: "public",
      published: true,
      sort: 1,
    },
    {
      slug: "how-camp-works",
      title: "How camp works",
      body: TEXT.members,
      visibility: "members",
      published: true,
      sort: 2,
    },
    {
      slug: "lead-handbook",
      title: "Lead handbook",
      body: TEXT.leads,
      visibility: "leads",
      published: true,
      sort: 3,
    },
    {
      slug: "coming-soon",
      title: "Coming soon",
      body: TEXT.draft,
      visibility: "public",
      published: false,
      sort: 4,
    },
  ]);
  await t.db.insert(guide).values({
    campId: z.campId,
    slug: "bravo-only",
    title: "Bravo only",
    body: TEXT.bravo,
    visibility: "public",
    published: true,
  });

  await invitePerson(t, "member@example.com");
  member = await signIn(w, "member@example.com");
  await w.fetch(get("/", member));
  const l = await invitePerson(t, "lead@example.com");
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
  await w.fetch(get("/", lead));
  const a = await invitePerson(t, "admin@example.com");
  await t.db.insert(memberRole).values({ personId: a.id, role: "admin" });
  admin = await signIn(w, "admin@example.com");
  await w.fetch(get("/", admin));
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("reading guides", () => {
  it("serves a public guide to anyone, indexable and briefly cacheable", async () => {
    const res = await w.fetch(get("/guides/welcome"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("all");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const html = await res.text();
    expect(html).toContain(TEXT.welcome);
    expect(html).toContain("Thinking of joining us?");
  });

  it("lists only published public guides when signed out", async () => {
    const html = await (await w.fetch(get("/guides"))).text();
    expect(html).toContain("Welcome");
    for (const title of ["How camp works", "Lead handbook", "Coming soon"]) {
      expect(html).not.toContain(title);
    }
  });

  it.each(["/guides/how-camp-works", "/guides/lead-handbook", "/guides/no-such-guide"])(
    "sends a signed-out visitor to sign-in for %s, revealing nothing",
    async (path) => {
      const res = await w.fetch(get(path));
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/sign-in");
      const body = await res.text();
      expect(body).not.toContain(TEXT.members);
      expect(body).not.toContain(TEXT.leads);
    },
  );

  it("shows members' guides to members, uncached, and the handbook only to Leads", async () => {
    const res = await w.fetch(get("/guides/how-camp-works", member));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toContain(TEXT.members);

    const denied = await w.fetch(get("/guides/lead-handbook", member));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(TEXT.leads);
    expect(await (await w.fetch(get("/guides", member))).text()).not.toContain("Lead handbook");

    const forLead = await w.fetch(get("/guides/lead-handbook", lead));
    expect(forLead.status).toBe(200);
    expect(await forLead.text()).toContain(TEXT.leads);
  });

  it("never shows a draft outside the editor, even to Leads", async () => {
    for (const cookie of [undefined, member, lead]) {
      const res = await w.fetch(get("/guides/coming-soon", cookie));
      expect([302, 404]).toContain(res.status);
      expect(await res.text()).not.toContain(TEXT.draft);
    }
  });

  it("keeps each camp's guides to its own site", async () => {
    const atA = await w.fetch(get("/guides/bravo-only"));
    expect(atA.status).toBe(302);
    expect(await atA.text()).not.toContain(TEXT.bravo);
    expect(await (await w.fetch(get("/guides"))).text()).not.toContain("Bravo only");

    const atB = await w.fetch(get("/guides/bravo-only", undefined, ZULU_BASE));
    expect(atB.status).toBe(200);
    expect(await atB.text()).toContain(TEXT.bravo);
    const welcomeAtB = await w.fetch(get("/guides/welcome", undefined, ZULU_BASE));
    expect(welcomeAtB.status).toBe(302);
    await welcomeAtB.text();
  });

  it("gives a signed-in non-member a 404 with no guide text", async () => {
    const p = await invitePerson(t, "gone@example.com");
    const cookie = await signIn(w, "gone@example.com");
    await w.fetch(get("/", cookie));
    await t.db.update(person).set({ active: false }).where(eq(person.id, p.id));
    const res = await w.fetch(get("/guides/how-camp-works", cookie));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(TEXT.members);
  });
});

describe("the guide editor", () => {
  const idOf = async (slug: string) =>
    (await t.db.select({ id: guide.id }).from(guide).where(eq(guide.slug, slug)))[0]?.id;
  // Each test makes its own guides through the editor, so none depends on another.
  const create = async (title: string) => {
    const res = await w.fetch(post("/guide-editor", { intent: "create", title }, { cookie: lead }));
    expect(res.status).toBe(302);
    return (res.headers.get("Location") ?? "").split("/").pop() as string;
  };
  const fields = (title: string, body = "Some text") => ({
    title,
    summary: "",
    visibility: "members",
    body,
  });

  it("lets a Lead draft, preview and publish a guide that members then see", async () => {
    const id = await create("Packing & Power");
    expect(await idOf("packing-and-power")).toBe(id);
    const body = "Bring **water**. <script>alert(1)</script> [RSVP](/rsvp)";

    const preview = await (
      await w.fetch(
        post(
          `/guide-editor/${id}`,
          { ...fields("Packing & Power", body), intent: "preview" },
          { cookie: lead },
        ),
      )
    ).text();
    expect(preview).toContain("<strong>water</strong>");
    expect(preview).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(preview).not.toContain("<script>alert(1)");
    // A preview saves nothing.
    expect((await t.db.select().from(guide).where(eq(guide.id, id)))[0].body).toBe("");
    expect((await w.fetch(get("/guides/packing-and-power", member))).status).toBe(404);

    const saved = await w.fetch(
      post(
        `/guide-editor/${id}`,
        { ...fields("Packing & Power", body), intent: "save_publish" },
        { cookie: lead },
      ),
    );
    expect(saved.status).toBe(302);
    const page = await w.fetch(get("/guides/packing-and-power", member));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<strong>water</strong>");
    expect(html).toContain('<a href="/rsvp" rel="nofollow noopener ugc">RSVP</a>');
    expect(html).not.toContain("<script>alert(1)");
  });

  it("audits every change, and the Activity page shows it", async () => {
    const id = await create("Audit trail");
    await w.fetch(
      post(
        `/guide-editor/${id}`,
        { ...fields("Audit trail"), intent: "save_publish" },
        { cookie: lead },
      ),
    );
    const rows = await t.db
      .select({ a: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.subjectId, id));
    expect(rows.map((r) => r.a).sort()).toEqual([
      "guide_created",
      "guide_published",
      "guide_saved",
    ]);
    const activity = await (await w.fetch(get("/admin/activity", admin))).text();
    expect(activity).toContain("Guide published: Audit trail");
  });

  it("reorders guides", async () => {
    const a = await create("Order first");
    const b = await create("Order second");
    const list = async () => await (await w.fetch(get("/guide-editor", lead))).text();
    let html = await list();
    expect(html.indexOf("Order first")).toBeLessThan(html.indexOf("Order second"));
    await w.fetch(post("/guide-editor", { intent: "up", id: b }, { cookie: lead }));
    html = await list();
    expect(html.indexOf("Order second")).toBeLessThan(html.indexOf("Order first"));
    expect(a).not.toBe(b);
  });

  it("keeps slugs unique within the camp, even for creates at the same moment", async () => {
    const ids = await Promise.all([
      create("Same title"),
      create("Same title"),
      create("Same title"),
    ]);
    const slugs = await Promise.all(
      ids.map(async (id) => (await t.db.select().from(guide).where(eq(guide.id, id)))[0].slug),
    );
    expect(slugs.sort()).toEqual(["same-title", "same-title-2", "same-title-3"]);
  });

  it("deletes only drafts", async () => {
    const id = await create("Delete me");
    await w.fetch(
      post(
        `/guide-editor/${id}`,
        { ...fields("Delete me"), intent: "save_publish" },
        { cookie: lead },
      ),
    );
    const refused = await w.fetch(
      post(`/guide-editor/${id}`, { intent: "delete" }, { cookie: lead }),
    );
    expect(await refused.text()).toContain("Unpublish the guide before deleting it.");
    await w.fetch(post("/guide-editor", { intent: "unpublish", id }, { cookie: lead }));
    await w.fetch(post(`/guide-editor/${id}`, { intent: "delete" }, { cookie: lead }));
    expect(await idOf("delete-me")).toBeUndefined();
  });

  it("treats unknown and malformed ids as not found", async () => {
    const page = await w.fetch(
      post("/guide-editor/not-a-uuid", { ...fields("x"), intent: "save" }, { cookie: lead }),
    );
    expect(page.status).toBe(404);
    await page.text();
    const list = await w.fetch(
      post("/guide-editor", { intent: "publish", id: "nope" }, { cookie: lead }),
    );
    expect(await list.text()).toContain("That guide doesn&#x27;t exist any more");
  });

  it("is for Leads and Admins only", async () => {
    expect((await w.fetch(get("/guide-editor", member))).status).toBe(403);
    const id = await idOf("welcome");
    expect((await w.fetch(get(`/guide-editor/${id}`, member))).status).toBe(403);
    expect((await w.fetch(get("/guide-editor", admin))).status).toBe(200);
  });
});

describe("links to guides from other pages", () => {
  it("shows a guide link only when the camp has that guide", async () => {
    expect(await (await w.fetch(get("/volunteer", member))).text()).not.toContain(
      "volunteer guide",
    );
    await t.db
      .insert(guide)
      .values({ slug: "volunteer", title: "Volunteering", visibility: "members", published: true });
    expect(await (await w.fetch(get("/volunteer", member))).text()).toContain(
      'href="/guides/volunteer"',
    );
  });

  it("thanks people who joined on the Welcome guide, or on its own page without one", async () => {
    const thanks = await w.fetch(get("/join/thanks"));
    expect(thanks.headers.get("Location")).toBe("/guides/welcome?joined=1");
    await thanks.text();
    const html = await (await w.fetch(get("/guides/welcome?joined=1"))).text();
    expect(html).toContain("Thanks for reaching out!");
    expect(html).not.toContain("Thinking of joining us?");

    const atB = await w.fetch(get("/join/thanks", undefined, ZULU_BASE));
    expect(atB.status).toBe(200);
    expect(await atB.text()).toContain("Thanks for reaching out!");
  });
});

describe("client bundle", () => {
  it("contains no guide text", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(process.cwd(), "build/client"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const phrase of Object.values(TEXT)) expect(text.includes(phrase), file).toBe(false);
    }
  });
});
