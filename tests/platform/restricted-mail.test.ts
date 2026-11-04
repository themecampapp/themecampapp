// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPlatformMail } from "../../platform/app/lib/mail.server";
import { TEST_EMAIL_ENV } from "../helpers/mail";

// Open-source plan, Unit 2.2: staging's allowlist is a Worker secret. A restricted instance
// (config mail.restricted, MAIL_RESTRICTED="true") whose secret is missing sends nothing,
// never to everyone.
afterEach(() => vi.unstubAllGlobals());

describe("platform mail on a restricted instance", () => {
  it("sends nothing while the allowlist is missing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const env = { ...TEST_EMAIL_ENV, MAIL_RESTRICTED: "true" } as unknown as PlatformEnv;
    const sent = await sendPlatformMail(
      env,
      (() => []) as unknown as postgres.Sql,
      ["ops@example.com"],
      "An alert",
      "Something happened.",
    );
    expect(sent).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
