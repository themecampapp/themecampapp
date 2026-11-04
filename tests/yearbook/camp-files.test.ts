// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, burn, campSettings, memberRole, person, sapPass } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedZulu, type Zulu } from "../helpers/two-camps";
import {
  get,
  invitePerson,
  post,
  signIn,
  startWorker,
  type TestWorker,
  upload,
} from "../helpers/worker";

// R4: each camp's files live under camps/<camp id>/ and are served only for that camp. A
// request never reaches another camp's object, even one that exists, and even if a row of
// this camp's somehow pointed at it.

let t: TestDb;
let w: TestWorker;
let z: Zulu;
let ana: { id: string; cookie: string };
let admin: string;
let lead: string;

const image = async (format: "png" | "jpeg" = "png", width = 800, height = 300) =>
  new Uint8Array(
    await sharp({
      create: { width, height, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.5 } },
    })
      [format]()
      .toBuffer(),
  );
const name = (key: string) => key.slice(key.lastIndexOf("/") + 1);
const foreignUuid = "00000000-0000-4000-8000-0000000000ff";

beforeAll(async () => {
  t = await createTestDb();
  z = await seedZulu(t);
  w = await startWorker(t);
  const a = await invitePerson(t, "ana@example.com", { legalName: "Ana Alpha" });
  ana = { id: a.id, cookie: await signIn(w, "ana@example.com") };
  const ad = await invitePerson(t, "admin@example.com", { legalName: "Ada Admin" });
  await t.db.insert(memberRole).values([
    { personId: ad.id, role: "admin" },
    { personId: ad.id, role: "lead" },
  ]);
  admin = await signIn(w, "admin@example.com");
  const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
  await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
  lead = await signIn(w, "lead@example.com");
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("photos", () => {
  it("stores under this camp's prefix and serves it privately", async () => {
    const res = await w.fetch(
      upload(
        "/profile",
        { intent: "photo_upload" },
        { name: "me.png", type: "image/png", bytes: await image() },
        ana.cookie,
      ),
    );
    expect(res.status).toBe(302);
    const [p] = await t.db.select().from(person).where(eq(person.id, ana.id));
    expect(p.photoKey).toMatch(new RegExp(`^camps/${t.campId}/p/`));
    const photo = await w.fetch(get(`/photos/${name(p.photoKey as string)}`, ana.cookie));
    expect(photo.status).toBe(200);
    expect(photo.headers.get("Cache-Control")).toBe("private, max-age=86400");
    expect(photo.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await photo.arrayBuffer();
  });

  it("never serves another camp's photo, though the object exists", async () => {
    await w.putObject(z.photoKey, await image("jpeg"), "image/webp");
    const res = await w.fetch(get(`/photos/${name(z.photoKey)}`, ana.cookie));
    expect(res.status).toBe(404);
    await res.text();
  });

  it("won't follow a row of this camp's that points into another camp", async () => {
    const foreign = `camps/${z.campId}/p/${foreignUuid}.webp`;
    await w.putObject(foreign, await image(), "image/webp");
    const [before] = await t.db.select().from(person).where(eq(person.id, ana.id));
    await t.db.update(person).set({ photoKey: foreign }).where(eq(person.id, ana.id));
    try {
      const res = await w.fetch(get(`/photos/${foreignUuid}.webp`, ana.cookie));
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      await t.db.update(person).set({ photoKey: before.photoKey }).where(eq(person.id, ana.id));
    }
  });

  it("refuses names that try to leave the camp's folder", async () => {
    for (const path of [
      "/photos/..%2F..%2Fsecret.webp",
      `/photos/camps%2F${z.campId}%2Fp%2F${name(z.photoKey)}`,
      "/photos/not-a-uuid.webp",
    ]) {
      const res = await w.fetch(get(path, ana.cookie));
      expect(res.status, path).toBe(404);
      await res.text();
    }
  });
});

describe("SAP PDFs", () => {
  it("won't serve a pass whose file sits under another camp's prefix", async () => {
    const [season] = await t.db.select().from(burn).where(eq(burn.year, 2027));
    const foreign = `camps/${z.campId}/sap/${foreignUuid}.pdf`;
    await w.putObject(foreign, new TextEncoder().encode("%PDF-1.4 x"), "application/pdf");
    const [pass] = await t.db
      .insert(sapPass)
      .values({ burnId: season.id, validDate: "2027-08-20", serial: "X1", pdfKey: foreign })
      .returning();
    const res = await w.fetch(get(`/saps/pass/${pass.id}/pdf`, lead));
    expect(res.status).toBe(404);
    await res.text();
  });
});

describe("the camp logo", () => {
  const logoUpload = async (bytes: Uint8Array, type = "image/png", cookie = admin) =>
    w.fetch(
      upload(
        "/admin/settings",
        { intent: "logo_upload" },
        { name: "logo", type, bytes },
        cookie,
        "logo",
      ),
    );
  const currentLogo = async () =>
    (await t.db.select().from(campSettings).where(eq(campSettings.campId, t.campId)))[0].logoKey;

  // Each test starts from a freshly uploaded 1600x400 logo.
  let logoKey: string;
  beforeEach(async () => {
    const res = await logoUpload(await image("png", 1600, 400));
    expect(res.status).toBe(302);
    logoKey = (await currentLogo()) as string;
  });

  it("stores a resized WebP under the camp, shows it in the header, and serves it to anyone", async () => {
    expect(logoKey).toMatch(new RegExp(`^camps/${t.campId}/logo/[0-9a-f-]{36}\\.webp$`));
    const meta = await sharp((await w.photo(logoKey)) as Uint8Array).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 400, height: 100, hasAlpha: true });

    const home = await (await w.fetch(get("/", ana.cookie))).text();
    expect(home).toContain(`src="/logo/${name(logoKey)}"`);
    const signIn = await (await w.fetch(get("/sign-in"))).text();
    expect(signIn).toContain(`src="/logo/${name(logoKey)}"`);
    // Public, like the sign-in page it's on.
    const logo = await w.fetch(get(`/logo/${name(logoKey)}`));
    expect(logo.status).toBe(200);
    expect(logo.headers.get("Content-Type")).toBe("image/webp");
    expect(logo.headers.get("Cache-Control")).toBe("public, max-age=86400");
    await logo.arrayBuffer();
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.action, "camp_logo_saved"));
    expect(row).toBeTruthy();
  });

  it("never enlarges a small logo", async () => {
    await logoUpload(await image("png", 200, 60));
    const meta = await sharp(
      (await w.photo((await currentLogo()) as string)) as Uint8Array,
    ).metadata();
    expect(meta).toMatchObject({ width: 200, height: 60 });
  });

  it("replacing it deletes the old file, and only the current logo is served", async () => {
    await logoUpload(await image("jpeg"));
    const after = await currentLogo();
    expect(after).not.toBe(logoKey);
    expect(await w.photo(logoKey)).toBeNull();
    const old = await w.fetch(get(`/logo/${name(logoKey)}`));
    expect(old.status).toBe(404);
    await old.text();
  });

  it("refuses SVG and other non-images, and non-Admins, changing nothing", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const res = await logoUpload(svg, "image/svg+xml");
    expect(await res.text()).toContain("SVG isn't accepted");
    const byLead = await logoUpload(await image(), "image/png", lead);
    expect(byLead.status).toBe(403);
    await byLead.text();
    const removeByLead = await w.fetch(
      post("/admin/settings", { intent: "logo_remove" }, { cookie: lead }),
    );
    expect(removeByLead.status).toBe(403);
    await removeByLead.text();
    expect(await currentLogo()).toBe(logoKey);
    expect(await w.photo(logoKey)).not.toBeNull();
  });

  it("removing it deletes the file and puts the balloon back", async () => {
    const res = await w.fetch(
      post("/admin/settings", { intent: "logo_remove" }, { cookie: admin }),
    );
    expect(res.status).toBe(302);
    expect(await currentLogo()).toBeNull();
    expect(await w.photo(logoKey)).toBeNull();
    const home = await (await w.fetch(get("/", ana.cookie))).text();
    expect(home).not.toContain('src="/logo/');
  });
});
