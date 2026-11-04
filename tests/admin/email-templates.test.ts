// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appSetting, auditLog, memberRole } from "~/db/schema";
import { DEFAULT_TEMPLATES, templateProblem } from "~/lib/email-templates";
import { renderTemplate } from "~/lib/mail.server";
import { createTestDb, type TestDb } from "../helpers/db";
import { get, invitePerson, post, signIn, startWorker, type TestWorker } from "../helpers/worker";

describe("template safeguards", () => {
  const ok = { subject: "Hello {year}", body: "Come on in: {link}" };
  it("accepts {link} and {year}", () => {
    expect(templateProblem("invite", ok)).toBeNull();
  });
  it("refuses edits that would break or garble an email", () => {
    expect(templateProblem("invite", { ...ok, body: "No link here" })).toMatch(
      /must include \{link\}/,
    );
    expect(templateProblem("invite", { ...ok, body: "Hi {yaer}: {link}" })).toMatch(
      /Unknown placeholder \{yaer\}/,
    );
    expect(templateProblem("invite", { ...ok, subject: "Two\nlines" })).toMatch(/one line/);
    expect(templateProblem("invite", { ...ok, subject: "Go {link}" })).toMatch(/not the subject/);
    expect(templateProblem("invite", { ...ok, subject: " " })).toMatch(/subject can't be empty/);
    expect(templateProblem("invite", { ...ok, body: "x".repeat(6000) + "{link}" })).toMatch(
      /under/,
    );
    // Emails without a link may drop it.
    expect(
      templateProblem("inquiry_confirmation", { subject: "Thanks", body: "Thanks!" }),
    ).toBeNull();
  });
  it("refuses web and email addresses: the only link is {link} (R35)", () => {
    for (const body of [
      "See example.com {link}",
      "Go to https://camp.example {link}",
      "www.camp {link}",
      "Write to lead@camp.org {link}",
    ]) {
      expect(templateProblem("invite", { ...ok, body }), body).toMatch(/only link/);
    }
    expect(templateProblem("invite", { ...ok, subject: "Visit camp.app" })).toMatch(/only link/);
    // Placeholders are filled in before checking: {camp}.org would become a real domain.
    for (const body of [
      "Learn more at {camp}.org {link}",
      "{year}.com {link}",
      "{day}.com {link}",
    ]) {
      expect(templateProblem("invite", { ...ok, body }), body).toMatch(/only link/);
    }
    expect(templateProblem("invite", { ...ok, body: "e.g. bring 5.5 gallons. {link}" })).toBeNull();
  });
  it("accepts the camp's name as a placeholder", () => {
    expect(templateProblem("invite", { ...ok, subject: "Join {camp}" })).toBeNull();
  });
  it("never lets the sign-in link email or the Lead notification be edited", () => {
    expect(templateProblem("magic_link", ok)).toMatch(/can't be edited/);
    expect(templateProblem("inquiry_notify", ok)).toMatch(/can't be edited/);
  });
  it("renders the defaults with the camp's name", () => {
    const { subject, text } = renderTemplate("invite", {
      url: "https://x/sign-in",
      year: 2027,
      camp: "Test Camp",
      product: "Example Camps",
    });
    expect(subject).toBe("You're invited to the Test Camp camp app");
    expect(text).toBe(
      "You've been invited to the Test Camp camp app, where we plan the 2027 burn:\nRSVP, tickets, dues, and more.\n\nSign in here with this email address:\nhttps://x/sign-in",
    );
    expect(
      renderTemplate("rsvp_nudge", { url: "u", year: 2028, camp: "Test Camp", product: "X" })
        .subject,
    ).toBe("Are you coming to Test Camp in 2028?");
  });

  it("names the instance in the fixed emails (open-source plan 3.5)", () => {
    const t = renderTemplate("support_granted", {
      url: "u",
      year: 2027,
      day: "Friday",
      camp: "Test Camp",
      product: "Example Camps",
    });
    expect(t.subject).toBe("Example Camps support can now see Test Camp");
    expect(`${t.subject}\n${t.text}`).not.toContain("{product}");
  });
});

describe("editing emails through the real Worker", () => {
  let t: TestDb;
  let w: TestWorker;
  let admin: string;
  let lead: string;
  beforeAll(async () => {
    t = await createTestDb();
    w = await startWorker(t);
    const a = await invitePerson(t, "admin@example.com", { legalName: "Ada Admin" });
    await t.db.insert(memberRole).values({ personId: a.id, role: "admin" });
    admin = await signIn(w, "admin@example.com");
    const l = await invitePerson(t, "lead@example.com", { legalName: "Lee Lead" });
    await t.db.insert(memberRole).values({ personId: l.id, role: "lead" });
    lead = await signIn(w, "lead@example.com");
  });
  afterAll(async () => {
    await w.dispose();
    await t.drop();
  });

  it("lists the editable emails for Admins only", async () => {
    const html = await (await w.fetch(get("/admin/emails", admin))).text();
    for (const name of ["Invite", "RSVP nudge", "Join form confirmation", "Photo removed"]) {
      expect(html).toContain(name);
    }
    expect((await w.fetch(get("/admin/emails", lead))).status).toBe(403);
    expect((await w.fetch(get("/admin/emails/invite", lead))).status).toBe(403);
    expect((await w.fetch(get("/admin/emails/magic_link", admin))).status).toBe(404);
  });

  it("sends the Admin's wording, with the link and year filled in, and audits the edit", async () => {
    const res = await w.fetch(
      post(
        "/admin/emails/invite",
        { subject: "Join us for {year}!", body: "Hey! Sign in here:\n{link}\n\nLove, the leads" },
        { cookie: admin },
      ),
    );
    expect(res.status).toBe(302);
    const [a] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "email_template_saved"));
    expect(a).toMatchObject({ subjectId: "invite", after: { subject: "Join us for {year}!" } });

    const p = await invitePerson(t, "new@example.com", { legalName: "New Person" });
    const before = w.emails.length;
    await w.fetch(post(`/people/${p.id}`, { intent: "invite" }, { cookie: lead }));
    const mail = w.emails.slice(before).find((e) => e.to === "new@example.com");
    expect(mail?.text).toContain("Hey! Sign in here:");
    expect(mail?.text).toContain("/sign-in?email=new%40example.com");
    expect(mail?.text).toContain("Love, the leads");
    expect(mail?.text).not.toContain("{link}");
  });

  it("refuses a broken edit and keeps the saved one", async () => {
    const res = await w.fetch(
      post("/admin/emails/invite", { subject: "Oops", body: "Forgot the link" }, { cookie: admin }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("must include {link}");
    const [row] = await t.db
      .select()
      .from(appSetting)
      .where(eq(appSetting.key, "email_template:invite"));
    expect((row.value as { subject: string }).subject).toBe("Join us for {year}!");
  });

  it("resets to the default", async () => {
    await w.fetch(post("/admin/emails/invite", { intent: "reset" }, { cookie: admin }));
    expect(
      await t.db.select().from(appSetting).where(eq(appSetting.key, "email_template:invite")),
    ).toHaveLength(0);
    const html = await (await w.fetch(get("/admin/emails/invite", admin))).text();
    expect(html).toContain("default wording");
    expect(DEFAULT_TEMPLATES.invite.body).toContain("{link}");
  });

  it("refuses edits from non-Admins", async () => {
    const res = await w.fetch(
      post("/admin/emails/invite", { subject: "Hi", body: "{link}" }, { cookie: lead }),
    );
    expect(res.status).toBe(403);
  });
});
