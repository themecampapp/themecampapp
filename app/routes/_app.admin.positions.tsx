// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "react-router";

// Issue #106: elected positions are jobs now, filled by Leads on the jobs page. Old links and
// bookmarks to Admin → Positions land there.
export function loader() {
  return redirect("/volunteers");
}
