// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, burn, camp, campSettings, memberRole, person } from "~/db/schema";
import { APP_HOST_SUFFIX } from "../helpers/context";
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
let campB: string;
const B = `https://bravo.${APP_HOST_SUFFIX}`;

async function jpeg() {
  return new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#e8b931" } })
      .jpeg()
      .toBuffer(),
  );
}

beforeAll(async () => {
  t = await createTestDb();
  const [b] = await t.db.insert(camp).values({ slug: "bravo", name: "Bravo" }).returning();
  campB = b.id;
  await t.db.insert(burn).values({ campId: campB, year: 2027 });
  await t.db.insert(campSettings).values({ campId: campB, currentYear: 2027 });
  w = await startWorker(t);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

describe("leaving a camp", () => {
  it("blocks the camp's only Admin (and Lead) with a pointer to hand the role on", async () => {
    const p = await invitePerson(t, "boss@example.com");
    await t.db.insert(memberRole).values([
      { personId: p.id, role: "lead" },
      { personId: p.id, role: "admin" },
    ]);
    const cookie = await signIn(w, "boss@example.com");
    const res = await w.fetch(post("/profile", { intent: "leave", confirm: "on" }, { cookie }));
    expect(await res.text()).toMatch(/only (Lead|Admin)/);
    const [still] = await t.db.select().from(person).where(eq(person.id, p.id));
    expect(still.active).toBe(true);
  });

  it("needs the confirmation box", async () => {
    await invitePerson(t, "careful@example.com");
    const cookie = await signIn(w, "careful@example.com");
    const res = await w.fetch(post("/profile", { intent: "leave" }, { cookie }));
    expect(await res.text()).toMatch(/Tick the box/);
  });

  it("deactivates a member, deletes their photo, signs them out here only, and logs it", async () => {
    const email = "leo@example.com";
    const p = await invitePerson(t, email);
    await invitePerson(t, email, { campId: campB });
    const cookie = await signIn(w, email);
    const cookieB = await signIn(w, email, B);

    const up = await w.fetch(
      upload(
        "/profile",
        { intent: "photo_upload" },
        { name: "me.jpg", type: "image/jpeg", bytes: await jpeg() },
        cookie,
      ),
    );
    expect(up.status).toBe(302);
    const [withPhoto] = await t.db.select().from(person).where(eq(person.id, p.id));
    const key = withPhoto.photoKey as string;
    expect(await w.photo(key)).not.toBeNull();

    const res = await w.fetch(post("/profile", { intent: "leave", confirm: "on" }, { cookie }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in?left=1");

    const [after] = await t.db.select().from(person).where(eq(person.id, p.id));
    expect(after).toMatchObject({ active: false, photoKey: null });
    expect(await w.photo(key)).toBeNull();
    const logged = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, p.id), eq(auditLog.action, "person_left")));
    expect(logged).toHaveLength(1);

    // Signed out here...
    const here = await w.fetch(get("/profile", cookie));
    expect(here.status).toBe(302);
    await here.text();
    // ...but still signed in at the other camp.
    const there = await w.fetch(get("/profile", cookieB, B));
    expect(there.status).toBe(200);
    await there.text();
  });
});
