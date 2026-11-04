// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { useMatches } from "react-router";

// R74: tells the camp Worker (workers/app.ts) that something broke in the browser, so the
// operator can see it in the console's usage numbers. Only the error's type (TypeError, ...)
// and the page's route id are sent: never the message or stack, which can hold personal
// data. At most a few per page load, so a broken loop can't flood it.
const PATH = "/__usage/client-error";
let sent = 0;

export function reportClientError(error: unknown, route: string | undefined) {
  if (typeof navigator === "undefined" || !navigator.sendBeacon || !route || sent >= 5) return;
  sent++;
  const type = error instanceof Error ? error.name : "Unhandled";
  try {
    navigator.sendBeacon(PATH, new URLSearchParams({ type, route }));
  } catch {
    // Reporting is best effort.
  }
}

export function ErrorBeacon() {
  const matches = useMatches();
  const route = useRef<string | undefined>(undefined);
  route.current = matches[matches.length - 1]?.id;
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportClientError(e.error, route.current);
    const onRejection = (e: PromiseRejectionEvent) => reportClientError(e.reason, route.current);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
