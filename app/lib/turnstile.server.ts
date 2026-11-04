// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side Turnstile check. The widget alone protects nothing: every submission's token
// is verified with Cloudflare, bound to our hostname and the form's action name.
export async function verifyTurnstile(opts: {
  secret: string;
  token: string;
  ip: string | null;
  expectedHostname: string;
  expectedAction: string;
}): Promise<boolean> {
  if (!opts.token || opts.token.length > 2048) return false;
  const body = new URLSearchParams({ secret: opts.secret, response: opts.token });
  if (opts.ip) body.set("remoteip", opts.ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    if (!res.ok) return false;
    const result = (await res.json()) as { success: boolean; hostname?: string; action?: string };
    return (
      result.success === true &&
      result.hostname === opts.expectedHostname &&
      result.action === opts.expectedAction
    );
  } catch {
    return false;
  }
}
