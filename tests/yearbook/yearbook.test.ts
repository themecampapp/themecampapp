// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, memberRole, participation, person } from "~/db/schema";
import { cardLabel, sniffImage } from "~/lib/photos.server";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  get,
  invitePerson,
  post,
  signIn,
  startWorker,
  type TestWorker,
  upload,
} from "../helpers/worker";

let t: TestDb;
let w: TestWorker;
let lead: { id: string; cookie: string };
let ana: { id: string; cookie: string };
let ben: { id: string; cookie: string };

// A real JPEG carrying GPS coordinates in its EXIF, like a phone photo.
async function phoneJpeg(width = 1200, height = 900) {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 232, g: 185, b: 49 } } })
      .jpeg()
      .withExif({
        IFD0: { Make: "TestPhone" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 47/1 11/1" },
      })
      .toBuffer(),
  );
}

async function going(personId: string, intent: "going" | "leaning_no" = "going") {
  const [y] = await t.db.select().from(burn).where(eq(burn.year, 2027));
  await t.db
    .insert(participation)
    .values({ personId, burnId: y.id, intent })
    .onConflictDoUpdate({
      target: [participation.personId, participation.burnId],
      set: { intent },
    });
}

async function member(email: string, values: Partial<typeof person.$inferInsert>) {
  const p = await invitePerson(t, email, values);
  const cookie = await signIn(w, email);
  await w.fetch(get("/", cookie)); // first visit links the login
  return { id: p.id, cookie };
}

async function keyOf(personId: string) {
  const [p] = await t.db
    .select({ key: person.photoKey })
    .from(person)
    .where(eq(person.id, personId));
  return p.key;
}

const urlFor = (key: string) => `/photos/${key.split("/").pop()}`;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
  lead = await member("lead@example.com", { legalName: "Lena Lead", playaName: "Captain" });
  await t.db.insert(memberRole).values({ personId: lead.id, role: "lead" });
  ana = await member("ana@example.com", {
    legalName: "Ana Alpha",
    playaName: "Sunny",
    homeLocation: "Petaluma",
  });
  ben = await member("ben@example.com", { legalName: "Ben Beta" });
  await going(ana.id);
  await going(ben.id);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("photo helpers", () => {
  it("identifies images by their bytes, not their names", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("\0\0\0\x18ftypheic"))).toBe("heic");
    expect(
      sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")),
    ).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("labels cards with the playa name, and the first name only by opt-in or as a fallback", () => {
    expect(cardLabel({ playaName: "Sunny", legalName: "Ana Alpha", showFirstName: false })).toEqual(
      { label: "Sunny", secondary: null },
    );
    expect(cardLabel({ playaName: "Sunny", legalName: "Ana Alpha", showFirstName: true })).toEqual({
      label: "Sunny",
      secondary: "Ana",
    });
    expect(cardLabel({ playaName: null, legalName: "Ben Beta", showFirstName: false })).toEqual({
      label: "Ben",
      secondary: null,
    });
  });
});

describe("Yearbook through the real Worker (R2 + Images)", () => {
  it("re-encodes an upload to a 512x512 WebP with no EXIF/GPS, and shows it in the Yearbook", async () => {
    const res = await w.fetch(
      upload(
        "/profile",
        { intent: "photo_upload" },
        { name: "IMG_0001.JPG", type: "image/jpeg", bytes: await phoneJpeg() },
        ana.cookie,
      ),
    );
    expect(res.status).toBe(302);
    const key = await keyOf(ana.id);
    expect(key).toMatch(new RegExp(`^camps/${t.campId}/p/[0-9a-f-]{36}\\.webp$`));

    const stored = await w.photo(key as string);
    const meta = await sharp(stored as Uint8Array).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();

    const html = await (await w.fetch(get("/yearbook", ben.cookie))).text();
    expect(html).toContain("Sunny");
    expect(html).toContain("Petaluma");
    expect(html).toContain(urlFor(key as string));
    expect(html).not.toContain("Ana");
  });

  it("refuses files that aren't photos, whatever their name says, and stores nothing", async () => {
    const before = await w.photoKeys();
    for (const bytes of [
      new TextEncoder().encode(
        "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      ),
      new TextEncoder().encode("just some text"),
    ]) {
      const res = await w.fetch(
        upload(
          "/profile",
          { intent: "photo_upload" },
          { name: "cute.jpg", type: "image/jpeg", bytes },
          ben.cookie,
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Please upload a JPEG, PNG, WebP or HEIC photo.");
    }
    expect(await w.photoKeys()).toEqual(before);
    expect(await keyOf(ben.id)).toBeNull();
  });

  it("replacing a photo deletes the old object", async () => {
    const old = await keyOf(ana.id);
    await w.fetch(
      upload(
        "/profile",
        { intent: "photo_upload" },
        { name: "b.jpg", type: "image/jpeg", bytes: await phoneJpeg(640, 480) },
        ana.cookie,
      ),
    );
    const next = await keyOf(ana.id);
    expect(next).not.toBe(old);
    expect(await w.photo(old as string)).toBeNull();
    expect(await w.photo(next as string)).not.toBeNull();
  });

  it("serves photos privately with a fixed type, and never to signed-out visitors", async () => {
    const url = urlFor((await keyOf(ana.id)) as string);
    const res = await w.fetch(get(url, ben.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=86400");

    const anon = await w.fetch(get(url));
    expect(anon.status).toBe(302);
    expect(
      (await w.fetch(get("/photos/00000000-0000-0000-0000-000000000000.webp", ben.cookie))).status,
    ).toBe(404);
    expect((await w.fetch(get("/photos/..%2F..%2Fsecret", ben.cookie))).status).toBe(404);
  });

  it("hides someone's photo from other members once they're not coming, but not from them or Leads", async () => {
    const url = urlFor((await keyOf(ana.id)) as string);
    await going(ana.id, "leaning_no");
    expect((await w.fetch(get(url, ben.cookie))).status).toBe(404);
    expect((await w.fetch(get(url, ana.cookie))).status).toBe(200);
    expect((await w.fetch(get(url, lead.cookie))).status).toBe(200);
    expect(await (await w.fetch(get("/yearbook", ben.cookie))).text()).not.toContain("Sunny");
    await going(ana.id, "going");
  });

  it("shows the first name only after opting in", async () => {
    await w.fetch(
      post("/profile", { intent: "first_name", showFirstName: "on" }, { cookie: ana.cookie }),
    );
    expect(await (await w.fetch(get("/yearbook", ben.cookie))).text()).toContain("Ana");
  });

  it("lets a member remove their own photo, deleting the object", async () => {
    await w.fetch(
      upload(
        "/profile",
        { intent: "photo_upload" },
        { name: "b.jpg", type: "image/jpeg", bytes: await phoneJpeg() },
        ben.cookie,
      ),
    );
    const key = (await keyOf(ben.id)) as string;
    await w.fetch(post("/profile", { intent: "photo_remove" }, { cookie: ben.cookie }));
    expect(await keyOf(ben.id)).toBeNull();
    expect(await w.photo(key)).toBeNull();
  });

  it("lets a Lead remove a photo (emailing the person), but not a Member", async () => {
    const key = (await keyOf(ana.id)) as string;
    const refused = await w.fetch(
      post(`/people/${ana.id}`, { intent: "remove_photo" }, { cookie: ben.cookie }),
    );
    expect(refused.status).toBe(403);
    expect(await keyOf(ana.id)).toBe(key);

    const before = w.emails.length;
    await w.fetch(post(`/people/${ana.id}`, { intent: "remove_photo" }, { cookie: lead.cookie }));
    expect(await keyOf(ana.id)).toBeNull();
    expect(await w.photo(key)).toBeNull();
    expect(w.emails.slice(before).map((e) => e.to)).toEqual(["ana@example.com"]);
  });

  it("deletes a deactivated person's photo", async () => {
    await w.fetch(
      upload(
        "/profile",
        { intent: "photo_upload" },
        { name: "c.jpg", type: "image/jpeg", bytes: await phoneJpeg() },
        ben.cookie,
      ),
    );
    const key = (await keyOf(ben.id)) as string;
    await w.fetch(post(`/people/${ben.id}`, { intent: "deactivate" }, { cookie: lead.cookie }));
    expect(await keyOf(ben.id)).toBeNull();
    expect(await w.photo(key)).toBeNull();
  });

  it("opens the Directory when no one has a photo, and the photo tab says so", async () => {
    const html = await (await w.fetch(get("/yearbook", lead.cookie))).text();
    expect(html).toMatch(/aria-current="page"[^>]*>Directory</);
    const photos = await (await w.fetch(get("/yearbook?view=photos", lead.cookie))).text();
    expect(photos).toContain("No photos yet");
  });
});
