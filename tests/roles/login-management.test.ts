// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { loginManagementReason } from "~/lib/login-management";
import { BUILTIN_DEFAULTS, NO_ACCESS } from "~/lib/permissions";
import { asRoles } from "../helpers/viewer";

// Issue #93: who may manage someone's sign-in (invite, change their email, unlink, deactivate):
// People: manage, and only a person who can do nothing the actor can't. Only an Admin acts on
// an Admin.
describe("loginManagementReason", () => {
  it("needs People: manage", () => {
    expect(loginManagementReason(asRoles([]), asRoles([]))).toBe("forbidden");
    expect(loginManagementReason(asRoles(["treasurer"]), asRoles([]))).toBe("forbidden");
    const viewOnly = { access: { ...NO_ACCESS, people: "view" as const } };
    expect(loginManagementReason(viewOnly, asRoles([]))).toBe("forbidden");
  });

  it("lets a Lead manage members and other Leads", () => {
    expect(loginManagementReason(asRoles(["lead"]), asRoles([]))).toBeNull();
    expect(loginManagementReason(asRoles(["lead"]), asRoles(["lead"]))).toBeNull();
  });

  it("keeps a Lead off a Treasurer, whose dues access they don't have", () => {
    expect(loginManagementReason(asRoles(["lead"]), asRoles(["treasurer"]))).toBe("more_access");
    expect(loginManagementReason(asRoles(["lead"]), asRoles(["lead", "treasurer"]))).toBe(
      "more_access",
    );
    expect(
      loginManagementReason(asRoles(["lead", "treasurer"]), asRoles(["treasurer"])),
    ).toBeNull();
  });

  it("leaves Admins to Admins", () => {
    expect(loginManagementReason(asRoles(["lead", "treasurer"]), asRoles(["admin"]))).toBe(
      "admin_only",
    );
    expect(loginManagementReason(asRoles(["admin"]), asRoles(["admin"]))).toBeNull();
    expect(loginManagementReason(asRoles(["admin"]), asRoles(["lead", "treasurer"]))).toBeNull();
  });

  it("compares access, not role names", () => {
    // People: manage plus dues, but not the rest of a Lead's areas.
    const peopleAndDues = {
      access: { ...NO_ACCESS, people: "manage" as const, dues: "manage" as const },
    };
    expect(loginManagementReason(peopleAndDues, asRoles(["treasurer"]))).toBeNull();
    expect(loginManagementReason(peopleAndDues, asRoles(["lead"]))).toBe("more_access");
    expect(loginManagementReason({ access: BUILTIN_DEFAULTS.lead }, asRoles([]))).toBeNull();
  });

  it("leaves out the areas the camp doesn't use", () => {
    const noSaps = { access: { ...BUILTIN_DEFAULTS.lead, saps: "none" as const } };
    expect(loginManagementReason(noSaps, asRoles(["lead"]))).toBe("more_access");
    expect(loginManagementReason(noSaps, asRoles(["lead"]), { saps: false })).toBeNull();
  });
});
