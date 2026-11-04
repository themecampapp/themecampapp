// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Viewer } from "./access.server";
import type { Features } from "./features";
import { type Access, accessWithin, atLeast } from "./permissions";

// Controlling a person's sign-in address controls every role attached to that person. So it
// takes People: manage, and (issue #93) someone who isn't an Admin may act only on a person
// who can do nothing they can't, in the areas the camp uses. Only an Admin acts on an Admin.
export function loginManagementReason(
  actor: Pick<Viewer, "access" | "isAdmin">,
  target: { access: Access; isAdmin: boolean },
  features?: Partial<Features>,
): string | null {
  if (!atLeast(actor.access.people, "manage")) return "forbidden";
  if (actor.isAdmin) return null;
  if (target.isAdmin) return "admin_only";
  if (!accessWithin(target.access, actor.access, features)) return "more_access";
  return null;
}
