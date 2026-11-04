// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Viewer } from "~/lib/access.server";
import { accessForRoles, type RoleKind } from "~/lib/permissions";

// The access a viewer holding these built-in roles gets (issue #93), for tests that build a
// Viewer by hand: `{ personId, ..., ...asRoles(["lead"]) }`.
export function asRoles(
  roles: RoleKind[],
): Pick<Viewer, "access" | "roles"> & { isAdmin: boolean } {
  return { isAdmin: roles.includes("admin"), access: accessForRoles(roles), roles: [...roles] };
}
