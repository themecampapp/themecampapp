// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// How long an Admin can grant support access for (R39), in hours; shared by the form and the
// server. Seven days is the most.
export const DURATIONS = { "1h": 1, "1d": 24, "3d": 72, "7d": 168 } as const;
export type Duration = keyof typeof DURATIONS;
