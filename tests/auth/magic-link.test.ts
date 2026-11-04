// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user, verification } from "~/db/auth-schema";
import { invite, person, sendLog } from "~/db/schema";
import { getAuth } from "~/lib/context.server";
import * as signInRoute from "~/routes/sign-in";
import * as confirmRoute from "~/routes/sign-in.confirm";
import { APP_URL, args, formRequest, makeContext, stubMail } from "../helpers/context";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function invited(email: string) {
  const [p] = await t.db.insert(person).values({ legalName: "Invited Camper", email }).returning();
  await t.db.insert(invite).values({ personId: p.id, email, status: "pending" });
  return p;
}

async function requestLink(email: string, ip = "203.0.113.7") {
  const { context, finish } = makeContext(t.runtimeUrl);
  const res = await signInRoute.action(
    args(formRequest("/sign-in", { email }, { "cf-connecting-ip": ip }), context),
  );
  await finish();
  return res as Response;
}

function tokenFrom(text: string) {
  const url = text.split("\n").find((l) => l.includes("/sign-in/confirm"));
  return new URL(url ?? "").searchParams.get("token") ?? "";
}

async function confirm(token: string, headers: HeadersInit = {}) {
  const { context, finish } = makeContext(t.runtimeUrl);
  const res = await confirmRoute.action(
    args(formRequest("/sign-in/confirm", { token }, headers), context),
  );
  await finish();
  return res as Response;
}

describe("magic-link sign-in", () => {
  let mail: ReturnType<typeof stubMail>;
  beforeEach(() => {
    mail = stubMail();
  });

  it("emails an invited address a link to the confirm page, never the raw verify URL", async () => {
    await invited("happy@example.com");
    const res = await requestLink("happy@example.com");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in/check-email");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("happy@example.com");
    expect(mail.sent[0].text).toContain(`${APP_URL}/sign-in/confirm?token=`);
    expect(mail.sent[0].text).not.toContain("/api/auth/magic-link/verify");
  });

  it("gives an uninvited address the identical response and sends nothing", async () => {
    const res = await requestLink("stranger@example.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in/check-email");
    expect(mail.sent).toHaveLength(0);
  });

  it("sends nothing to a deactivated, previously linked person", async () => {
    const [u] = await t.db
      .insert(user)
      .values({ id: "u-deactivated", name: "x", email: "gone@example.com", emailVerified: true })
      .returning();
    await t.db
      .insert(person)
      .values({ legalName: "Gone", email: "gone@example.com", authUserId: u.id, active: false });

    await requestLink("gone@example.com");
    expect(mail.sent).toHaveLength(0);
  });

  it("matches the invite after trimming and lowercasing", async () => {
    await invited("mixed@example.com");
    await requestLink("  MIXED@Example.com ");
    expect(mail.sent.map((m) => m.to)).toEqual(["mixed@example.com"]);
  });

  it("throttles repeated requests for one email with the same generic response", async () => {
    await invited("spam@example.com");
    for (let i = 0; i < 7; i++) {
      const res = await requestLink("spam@example.com", `198.51.100.${i}`);
      expect(res.headers.get("Location")).toBe("/sign-in/check-email");
    }
    expect(mail.sent).toHaveLength(5);
  });

  it("rejects a malformed email with a form error instead of redirecting", async () => {
    const res = await requestLink("not-an-email");
    expect(res).toEqual({ error: "Please enter a valid email address." });
  });

  it("does not wait for the email to send before responding", async () => {
    await invited("slow@example.com");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response("{}", { status: 200 });
      }),
    );
    const { context, finish } = makeContext(t.runtimeUrl);
    const res = (await signInRoute.action(
      args(formRequest("/sign-in", { email: "slow@example.com" }), context),
    )) as Response;
    expect(res.headers.get("Location")).toBe("/sign-in/check-email");
    release();
    await finish();
  });

  it("records failed sends in send_log without the link", async () => {
    await invited("bounce@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await requestLink("bounce@example.com");
    const rows = await t.db
      .select()
      .from(sendLog)
      .where(eq(sendLog.recipient, "bounce@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(JSON.stringify(rows[0])).not.toContain("token");
  });
});

describe("confirm page", () => {
  let mail: ReturnType<typeof stubMail>;
  beforeEach(() => {
    mail = stubMail();
  });

  it("shows the page on GET without consuming the token", async () => {
    await invited("scanner@example.com");
    await requestLink("scanner@example.com");
    const token = tokenFrom(mail.sent[0].text);
    const before = await t.db.select().from(verification);

    const { context, finish } = makeContext(t.runtimeUrl);
    const data = await confirmRoute.loader(
      args(new Request(`${APP_URL}/sign-in/confirm?token=${token}`), context),
    );
    await finish();
    expect(data).toEqual({ token });
    expect(await t.db.select().from(verification)).toHaveLength(before.length);

    const res = await confirm(token);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP_URL}/`);
    expect(res.headers.getSetCookie().join(";")).toMatch(/session_token/);
  });

  it("sends a reused token to the error page", async () => {
    await invited("twice@example.com");
    await requestLink("twice@example.com");
    const token = tokenFrom(mail.sent[0].text);

    expect((await confirm(token)).headers.get("Location")).toBe(`${APP_URL}/`);
    const again = await confirm(token);
    expect(again.headers.get("Location")).toMatch(/\/sign-in\/error/);
  });

  it("lets a second submission of the same link in once the first has signed them in", async () => {
    await invited("double@example.com");
    await requestLink("double@example.com");
    const token = tokenFrom(mail.sent[0].text);

    const first = await confirm(token);
    const cookie = first.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const again = await confirm(token, { cookie });
    expect(again.headers.get("Location")).toBe("/");
  });

  it("refuses to create a login if the invite was revoked before the link was used", async () => {
    await invited("revoked@example.com");
    await requestLink("revoked@example.com");
    const token = tokenFrom(mail.sent[0].text);
    await t.db
      .update(invite)
      .set({ status: "revoked" })
      .where(eq(invite.email, "revoked@example.com"));

    const res = await confirm(token);
    expect(res.headers.get("Location")).toMatch(/\/sign-in\/error/);
    expect(
      await t.db.select().from(user).where(eq(user.email, "revoked@example.com")),
    ).toHaveLength(0);
  });
});

describe("auth HTTP surface", () => {
  it.each([
    ["/api/auth/sign-up/email", { email: "x@example.com", password: "password123", name: "x" }],
    ["/api/auth/update-user", { name: "x" }],
    ["/api/auth/change-email", { newEmail: "x@example.com" }],
  ])("blocks %s", async (path, body) => {
    const { context, finish } = makeContext(t.runtimeUrl);
    const res = await getAuth(context).handler(
      new Request(`${APP_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_URL },
        body: JSON.stringify(body),
      }),
    );
    await finish();
    expect([400, 403, 404]).toContain(res.status);
    expect(await t.db.select().from(user).where(eq(user.email, "x@example.com"))).toHaveLength(0);
  });
});
