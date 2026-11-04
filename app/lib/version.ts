// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The running release (open-source plan 6.1), from package.json at build time: shown at the foot
// of Admin → Guide and in the operator's feedback email, so a support conversation can start
// from "which version are you on?". Only `version` is bundled, not the rest of package.json.
import { version } from "../../package.json";

export const APP_VERSION: string = version;
