// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

// Feedback for every form on the site, without each page wiring it up: while a post is being
// sent, the button that sent it shows a spinner (app.css, [data-pending]) and its form takes no
// more submits, so a second click can't send it twice. A thin bar shows any page load.
//
// The button is only marked once the router is actually sending, so a submit a page cancels
// (an "Are you sure?" answered No) never leaves it stuck. A GET form (the roster's filters) is
// never blocked: changing one filter after another should just show the latest.
export function PendingFeedback() {
  const navigation = useNavigation();
  const last = useRef<{ form: HTMLFormElement; submitter: HTMLElement | null } | null>(null);

  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.dataset.pending) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      last.current = { form, submitter: e.submitter instanceof HTMLElement ? e.submitter : null };
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  const sending = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  useEffect(() => {
    if (!sending || !last.current) return;
    const { form, submitter } = last.current;
    const button =
      submitter ?? form.querySelector<HTMLElement>('button[type="submit"], button:not([type])');
    form.dataset.pending = "true";
    button?.setAttribute("data-pending", "true");
    button?.setAttribute("aria-busy", "true");
    return () => {
      delete form.dataset.pending;
      button?.removeAttribute("data-pending");
      button?.removeAttribute("aria-busy");
    };
  }, [sending]);

  // Only after a moment, so quick page changes don't flash.
  const busy = navigation.state !== "idle";
  const [showBar, setShowBar] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShowBar(false);
      return;
    }
    const timer = setTimeout(() => setShowBar(true), 150);
    return () => clearTimeout(timer);
  }, [busy]);

  return showBar ? <div className="page-progress" role="progressbar" aria-label="Loading" /> : null;
}
