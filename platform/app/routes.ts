// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { index, layout, prefix, type RouteConfig, route } from "@react-router/dev/routes";

// The public site (apex) and the operator console (/ops on the ops. host, behind Cloudflare
// Access; platform/workers/app.ts refuses /ops anywhere else and checks the Access token).
export default [
  index("routes/_index.tsx"),
  route("legal/:doc", "routes/legal.$doc.tsx"),
  route("signup", "routes/signup.tsx"),
  route("signup/thanks", "routes/signup.thanks.tsx"),
  layout("routes/ops.tsx", [
    ...prefix("ops", [
      index("routes/ops._index.tsx"),
      route("camps/new", "routes/ops.camps.new.tsx"),
      route("camps/:id", "routes/ops.camps.$id.tsx"),
      route("log", "routes/ops.log.tsx"),
      route("requests", "routes/ops.requests.tsx"),
      route("signups", "routes/ops.signups._index.tsx"),
      route("signups/:id", "routes/ops.signups.$id.tsx"),
      route("feedback", "routes/ops.feedback.tsx"),
      route("usage", "routes/ops.usage.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
