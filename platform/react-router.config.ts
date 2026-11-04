// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from "@react-router/dev/config";

// The platform Worker: public site, operator console, Resend webhook and cron.
export default {
  ssr: true,
} satisfies Config;
