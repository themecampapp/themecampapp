// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { emailApiKey, sendEmail } from "../../../app/lib/email/provider";

// Plain text as the body of an email: escaped, and kept as written.
const preformatted = (text: string) =>
  `<pre style="font-family:sans-serif;white-space:pre-wrap">${text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</pre>`;

// Plain-text email from the platform itself (operator alerts, telling a camp's Admins about a
// suspension). Through the instance's email provider like the camp Worker's mail; on staging
// only to MAIL_ALLOWLIST, and never to a suppressed address. Returns how many addresses the
// provider accepted.
export async function sendPlatformMail(
  env: PlatformEnv,
  sql: postgres.Sql,
  to: string[],
  subject: string,
  text: string,
): Promise<number> {
  if (!emailApiKey(env)) {
    console.error(`platform mail "${subject}" not sent: no EMAIL_API_KEY`);
    return 0;
  }
  const allow = (env.MAIL_ALLOWLIST ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // A restricted instance (staging) with no allowlist sends nothing.
  if (allow.length === 0 && env.MAIL_RESTRICTED === "true") return 0;
  const wanted = [...new Set(to.map((e) => e.trim().toLowerCase()))].filter(
    (e) => allow.length === 0 || allow.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a)),
  );
  if (!wanted.length) return 0;
  const suppressed = new Set(
    (
      await sql<
        { email: string }[]
      >`select email from email_suppression where email in ${sql(wanted)}`
    ).map((r) => r.email),
  );
  let accepted = 0;
  for (const address of wanted.filter((e) => !suppressed.has(e))) {
    const { error } = await sendEmail(env, {
      to: address,
      from: { name: env.PRODUCT_NAME, email: env.ALERT_MAIL_FROM },
      subject,
      html: preformatted(text),
      text,
    });
    if (!error) accepted++;
    else console.error(`platform mail "${subject}" failed: ${error}`);
  }
  return accepted;
}

// An alert to the operator (OPERATOR_EMAIL): never allowlisted or suppressed, since it goes to
// the operator's own address. Returns whether the provider took it.
export async function alertOperator(env: PlatformEnv, subject: string, text: string) {
  if (!emailApiKey(env) || !env.OPERATOR_EMAIL) {
    console.error(`operator alert "${subject}" not sent: no EMAIL_API_KEY or OPERATOR_EMAIL`);
    return false;
  }
  const { error } = await sendEmail(env, {
    to: env.OPERATOR_EMAIL,
    from: { name: env.PRODUCT_NAME, email: env.ALERT_MAIL_FROM },
    subject,
    html: preformatted(text),
    text,
  });
  if (error) console.error(`operator alert "${subject}" failed: ${error}`);
  return !error;
}
