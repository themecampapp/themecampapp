// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Notifications to the Theme Camp App operator's private Discord channel (#admin; issue #79,
// moved from Slack, issue #32), through a Discord webhook kept as the DISCORD_WEBHOOK_URL
// secret on each Worker. Without one (tests aside, staging), nothing is sent. Shared by the
// camp and platform Workers.
//
// What's sent must never identify a camp member: sign-ins are the camp, the role and the time
// only.

const WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

// Discord's inline Markdown characters (bold, italics, strike, code, spoilers, masked links),
// escaped so a camp's name shows as typed. Messages never start with a camp's name, so
// line-start markup (headings, lists, quotes) can't apply.
export const discordEscape = (s: string) => s.replace(/[\\*_~`|[\]]/g, "\\$&");

// A time Discord shows in each reader's own time zone ("October 3, 2026 3:42 PM").
export const discordTime = (at: Date) => `<t:${Math.floor(at.getTime() / 1000)}:f>`;

// Never throws and gives up after 5 seconds: a notification must not break what triggered it.
// Mentions are off, so nothing a camp typed can ping the channel.
export async function notifyOperator(
  webhookUrl: string | undefined,
  text: string,
): Promise<boolean> {
  if (!webhookUrl) return false;
  if (!WEBHOOK_RE.test(webhookUrl)) {
    console.error("notify: DISCORD_WEBHOOK_URL isn't a Discord webhook URL");
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`notify: Discord webhook answered ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`notify: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export type SignInRole = "admin" | "lead" | "treasurer" | "member" | "not_member";
const ROLE_LABEL: Record<SignInRole, string> = {
  admin: "Admin",
  lead: "Lead",
  treasurer: "Treasurer",
  member: "Member",
  not_member: "No camp record yet",
};

// The person's highest role, from their roles (null: no active person with that email).
export function signInRole(roles: string[] | null): SignInRole {
  if (!roles) return "not_member";
  for (const r of ["admin", "lead", "treasurer"] as const) if (roles.includes(r)) return r;
  return "member";
}

export const signInMessage = (camp: string, role: SignInRole, at: Date) =>
  `🔑 Sign-in · **${discordEscape(camp)}** · ${ROLE_LABEL[role]} · ${discordTime(at)}`;

export const campCreatedMessage = (c: { name: string; site: string; year: number }) =>
  `⛺ New camp: **${discordEscape(c.name)}** (<${c.site}>), ${c.year} season`;

export const signupMessage = (c: { name: string; organizers: number; review: string }) =>
  `📥 Sign-up request: **${discordEscape(c.name)}** (${c.organizers} ${c.organizers === 1 ? "organizer" : "organizers"}). Review it at <${c.review}>`;
