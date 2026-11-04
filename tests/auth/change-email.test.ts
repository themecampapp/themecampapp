// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "~/db/auth-schema";
import { auditLog, emailChange, leadQueueItem, person } from "~/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  get,
  invitePerson,
  post,
  requestLinkToken,
  signIn,
  startWorker,
  type TestWorker,
} from "../helpers/worker";

// Self-service sign-in email change, in two steps (security review S4): the current address
// approves, then the new address confirms. Then the login is signed out everywhere.

let t: TestDb;
let w: TestWorker;

beforeAll(async () => {
  t = await createTestDb();
  w = await startWorker(t);
});
afterAll(async () => {
  await w.dispose();
  await t.drop();
});

async function member(email: string) {
  const p = await invitePerson(t, email, { legalName: `Person ${email}` });
  const cookie = await signIn(w, email);
  await w.fetch(get("/", cookie)); // first visit links the login
  return { id: p.id, email, cookie };
}

// The token in the newest email to `to` that links to `path`, or "".
function tokenIn(since: number, to: string, path: string) {
  const mail = w.emails
    .slice(since)
    .reverse()
    .find((e) => e.to === to && e.text.includes(path));
  const line = mail?.text.split("\n").find((l) => l.includes(path)) ?? "";
  return line ? (new URL(line).searchParams.get("token") ?? "") : "";
}

// Asks for the change; returns the approval token emailed to the current address.
async function requestChange(m: { cookie: string; email: string }, newEmail: string) {
  const before = w.emails.length;
  const res = await w.fetch(
    post("/profile", { intent: "email_change", newEmail }, { cookie: m.cookie }),
  );
  return { res, before, approveToken: tokenIn(before, m.email, "/email/approve") };
}

// Approves; returns the confirmation token emailed to the new address.
async function approve(token: string, newEmail: string) {
  const before = w.emails.length;
  const res = await w.fetch(post("/email/approve", { token }));
  const text = await res.text();
  return { text, confirmToken: tokenIn(before, newEmail, "/email/confirm") };
}

const confirm = (token: string) => w.fetch(post("/email/confirm", { token }));

async function emailsOf(personId: string) {
  const [p] = await t.db.select().from(person).where(eq(person.id, personId));
  const [u] = await t.db
    .select()
    .from(user)
    .where(eq(user.id, p.authUserId as string));
  return { person: p.email, login: u.email };
}

async function magicLinkSentTo(email: string) {
  const before = w.emails.length;
  await w.fetch(post("/sign-in", { email }));
  for (let i = 0; i < 40; i++) {
    if (w.emails.slice(before).some((e) => e.to === email)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("self-service sign-in email change", () => {
  it("needs the current address to approve, then the new one to confirm, and signs out everywhere", async () => {
    const m = await member("old@example.com");
    const { res, before, approveToken } = await requestChange(m, " New@Example.com ");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/profile?saved=email_sent");
    expect(approveToken).toBeTruthy();
    // Nothing goes to the new address until the current one approves, and the approval email
    // doesn't carry the new address (it's shown on the page behind the link).
    expect(w.emails.slice(before).map((e) => e.to)).toEqual(["old@example.com"]);
    expect(w.emails.slice(before)[0].text).not.toContain("new@example.com");

    // Opening the approval link (what a mail scanner does) changes nothing.
    const page = await w.fetch(get(`/email/approve?token=${encodeURIComponent(approveToken)}`));
    const pageText = await page.text();
    expect(pageText).toContain("Approve the change");
    expect(pageText).toContain("new@example.com");
    expect(tokenIn(before, "new@example.com", "/email/confirm")).toBe("");

    // The approval token isn't a confirmation token.
    expect(await (await confirm(approveToken)).text()).toContain("expired or was already used");

    const { text: approvedText, confirmToken } = await approve(approveToken, "new@example.com");
    expect(approvedText).toContain("Now confirm the new address");
    expect(confirmToken).toBeTruthy();
    expect(await emailsOf(m.id)).toEqual({ person: "old@example.com", login: "old@example.com" });
    // The approval works once.
    expect((await approve(approveToken, "new@example.com")).text).toContain("can&#x27;t be used");

    // A sign-in link already waiting at the old address.
    const pendingLink = await requestLinkToken(w, "old@example.com");

    // Opening the confirmation link changes nothing either.
    const confirmPage = await w.fetch(
      get(`/email/confirm?token=${encodeURIComponent(confirmToken)}`),
    );
    expect(await confirmPage.text()).toContain("Confirm new email");
    expect(await emailsOf(m.id)).toEqual({ person: "old@example.com", login: "old@example.com" });

    const sent = w.emails.length;
    const done = await confirm(confirmToken);
    expect(done.status).toBe(200);
    const doneText = await done.text();
    expect(doneText).toContain("new@example.com");
    expect(doneText).toContain("signed out everywhere");
    expect(await emailsOf(m.id)).toEqual({ person: "new@example.com", login: "new@example.com" });
    expect(w.emails.slice(sent).map((e) => e.to)).toEqual(["old@example.com"]);
    expect(w.emails.slice(sent)[0].text).not.toContain("new@example.com");

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.subjectId, m.id));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["email_change_requested", "email_change_approved", "email_changed"]),
    );

    // Signed out: the old session no longer works.
    const profile = await w.fetch(get("/profile", m.cookie));
    expect(profile.status).toBe(302);
    expect(profile.headers.get("Location")).toBe("/sign-in");
    await profile.text();
    // The link that was waiting at the old address is dead.
    const stale = await w.fetch(post("/sign-in/confirm", { token: pendingLink }));
    expect(stale.headers.getSetCookie().join(";")).not.toMatch(/session_token=[^;]/);
    await stale.text();
    // Sign-in now works with the new address only.
    expect(await magicLinkSentTo("new@example.com")).toBe(true);
    expect(await magicLinkSentTo("old@example.com")).toBe(false);
    const again = await signIn(w, "new@example.com");
    expect((await w.fetch(get("/profile", again))).status).toBe(200);

    // The confirmation works once.
    expect(await (await confirm(confirmToken)).text()).toContain("expired or was already used");
  });

  it("refuses an expired link, and only the newest request can be approved", async () => {
    const m = await member("second@example.com");
    const first = await requestChange(m, "second-a@example.com");
    const latest = await requestChange(m, "second-b@example.com");
    expect((await approve(first.approveToken, "second-a@example.com")).text).toContain(
      "can&#x27;t be used",
    );
    const { confirmToken } = await approve(latest.approveToken, "second-b@example.com");
    await t.db.update(emailChange).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await (await confirm(confirmToken)).text()).toContain("expired or was already used");
    expect((await emailsOf(m.id)).login).toBe("second@example.com");
  });

  it("refuses an address someone else uses, tells Leads, and sends nothing", async () => {
    const a = await member("alpha@example.com");
    await invitePerson(t, "taken@example.com", { legalName: "Taken Person" });
    const { res, before } = await requestChange(a, "taken@example.com");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("can&#x27;t be used");
    expect(w.emails.slice(before)).toHaveLength(0);
    const queued = await t.db
      .select()
      .from(leadQueueItem)
      .where(
        and(eq(leadQueueItem.personId, a.id), eq(leadQueueItem.kind, "email_change_conflict")),
      );
    expect(queued).toHaveLength(1);
    // Another member's sign-in address is refused the same way.
    await member("beta@example.com");
    expect(await (await requestChange(a, "beta@example.com")).res.text()).toContain(
      "can&#x27;t be used",
    );
  });

  it("refuses a change that became a conflict after the links were sent, and queues it", async () => {
    const m = await member("gamma@example.com");
    const { approveToken } = await requestChange(m, "later@example.com");
    const { confirmToken } = await approve(approveToken, "later@example.com");
    await invitePerson(t, "later@example.com", { legalName: "Later Person" });
    expect(await (await confirm(confirmToken)).text()).toContain("already used by someone else");
    expect((await emailsOf(m.id)).login).toBe("gamma@example.com");
    const queued = await t.db
      .select()
      .from(leadQueueItem)
      .where(
        and(eq(leadQueueItem.personId, m.id), eq(leadQueueItem.kind, "email_change_conflict")),
      );
    expect(queued).toHaveLength(1);
  });

  it("refuses bad input and a deactivated person's links", async () => {
    const m = await member("delta@example.com");
    expect(await (await requestChange(m, "not-an-email")).res.text()).toContain(
      "doesn&#x27;t look right",
    );
    expect(await (await requestChange(m, "DELTA@example.com")).res.text()).toContain(
      "already your sign-in email",
    );
    const { approveToken } = await requestChange(m, "delta-new@example.com");
    await t.db.update(person).set({ active: false }).where(eq(person.id, m.id));
    expect((await approve(approveToken, "delta-new@example.com")).text).toContain(
      "can&#x27;t be used",
    );
    expect((await approve("nonsense", "x@example.com")).text).toContain("can&#x27;t be used");
    expect(await (await confirm("nonsense")).text()).toContain("expired or was already used");
  });

  it("refuses the change request when signed out", async () => {
    const res = await w.fetch(
      post("/profile", { intent: "email_change", newEmail: "x@example.com" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/sign-in");
  });
});
