// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFetcher, useNavigate, useSearchParams } from "react-router";
import { btn } from "~/components/ui";
import {
  ORIENTATION_STEPS,
  type OrientationLevel,
  type OrientationStep,
  orientationStart,
  orientationSteps,
} from "~/lib/orientation";

// Issue #65: the Lead and Admin orientation, on the home page. A popover points at each link
// in turn (on phones, inside the Menu, which it opens); Pause or Escape closes it until the
// next visit, picking up at the same step; Stop ends it for good; "Take the tour" restarts it.
// Progress is saved on the person; the demo, which saves nothing, keeps it in the browser.

const GUTTER = 16;
const PAUSED_KEY = "tca-orientation-paused"; // closed for the rest of this browser session
const localKey = (level: OrientationLevel) => `tca-orientation-${level}`;

function storage(kind: "local" | "session") {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}
function readLocal(level: OrientationLevel): { done?: boolean; step?: string } {
  try {
    return JSON.parse(storage("local")?.getItem(localKey(level)) ?? "{}");
  } catch {
    return {};
  }
}
function writeLocal(level: OrientationLevel, value: { done?: boolean; step?: string }) {
  try {
    storage("local")?.setItem(localKey(level), JSON.stringify(value));
  } catch {}
}

// Inside a closed <details>, Chrome still gives the Menu's links a size, so ask the browser
// (and check the Menu is open).
const visible = (el: Element) => {
  const details = el.closest("details");
  if (details && !details.open) return false;
  return el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0;
};
const menu = () => document.querySelector<HTMLDetailsElement>("details[data-mobile-menu]");

// The on-screen element for a step: the header link on wide screens, the Menu's on phones.
function findAnchor(anchor: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`)];
  const shown = all.find(visible);
  if (shown) {
    // A link outside the Menu: close the Menu if the tour opened it.
    const m = menu();
    if (m?.open && !m.contains(shown)) m.open = false;
    return shown;
  }
  const m = menu();
  if (m && all.some((el) => m.contains(el))) {
    m.open = true;
    return all.find((el) => m.contains(el) && visible(el)) ?? null;
  }
  return null;
}

export type OrientationProps = {
  level: OrientationLevel;
  // Server-saved progress: where it starts on its own (null: it doesn't). Absent in the demo,
  // where the browser keeps it.
  start?: string | null;
  local: boolean;
  // Something else is asking for the member's attention first (privacy notice...).
  hold: boolean;
};

export function Orientation({ level, start, local, hold }: OrientationProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [steps, setSteps] = useState<OrientationStep[]>([]);
  const [index, setIndex] = useState<number | null>(null);
  // It starts on its own at most once per visit to the page, so closing it doesn't reopen it
  // before the saved progress comes back.
  const autoStarted = useRef(false);

  // The steps whose link is on this page (features the camp has off are skipped).
  const available = useCallback(
    () =>
      orientationSteps(level).filter(
        (s) => !s.anchor || document.querySelector(`[data-tour="${s.anchor}"]`),
      ),
    [level],
  );

  const open = useCallback(
    (key: string | null) => {
      const list = available();
      const i = Math.max(
        0,
        list.findIndex((s) => s.key === key),
      );
      setSteps(list);
      setIndex(i);
    },
    [available],
  );

  // Start on its own, or from "Take the tour" (?tour=start).
  useEffect(() => {
    if (params.get("tour") === "start") {
      storage("session")?.removeItem(PAUSED_KEY);
      open(ORIENTATION_STEPS[0].key);
      const next = new URLSearchParams(params);
      next.delete("tour");
      navigate({ search: next.toString() ? `?${next}` : "" }, { replace: true });
      return;
    }
    if (hold || autoStarted.current || storage("session")?.getItem(PAUSED_KEY)) return;
    autoStarted.current = true;
    const from = local
      ? (() => {
          const saved = readLocal(level);
          return orientationStart(level, saved.done ? level : null, saved.step ?? null);
        })()
      : (start ?? null);
    if (from) open(from);
  }, [params, hold, local, level, start, open, navigate]);

  const save = (intent: "pause" | "stop" | "finish", step?: string) => {
    if (local) {
      writeLocal(level, intent === "pause" ? { step } : { done: true });
    } else {
      fetcher.submit(
        { intent, ...(step ? { step } : {}) },
        { method: "post", action: "/orientation" },
      );
    }
  };
  const close = useCallback(() => {
    const m = menu();
    if (m) m.open = false;
    setIndex(null);
  }, []);

  const step = index === null ? null : steps[index];
  if (!step || index === null) return null;
  const last = index === steps.length - 1;
  return (
    <TourPopover
      key={step.key}
      step={step}
      position={`${index + 1} of ${steps.length}`}
      onBack={index > 0 ? () => setIndex(index - 1) : undefined}
      onNext={() => {
        if (last) {
          save("finish");
          close();
        } else setIndex(index + 1);
      }}
      nextLabel={last ? "Done" : "Next"}
      onPause={() => {
        storage("session")?.setItem(PAUSED_KEY, "1");
        save("pause", step.key);
        close();
      }}
      onStop={() => {
        save("stop");
        close();
      }}
    />
  );
}

type Box = { top: number; left: number; width: number; height: number };

function TourPopover({
  step,
  position,
  onBack,
  onNext,
  nextLabel,
  onPause,
  onStop,
}: {
  step: OrientationStep;
  position: string;
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  onPause: () => void;
  onStop: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [target, setTarget] = useState<Box | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  // Where the link is and where the card goes, again on every resize or scroll.
  useLayoutEffect(() => {
    let anchorEl: HTMLElement | null = null;
    if (step.anchor) {
      anchorEl = findAnchor(step.anchor);
      anchorEl?.scrollIntoView({ block: "nearest" });
    }
    const measure = () => {
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const h = card.current?.offsetHeight ?? 0;
      const w = card.current?.offsetWidth ?? 0;
      if (!anchorEl) {
        setTarget(null);
        setPlace({ top: Math.max(GUTTER, (vh - h) / 2), left: (vw - w) / 2 });
        return;
      }
      const r = anchorEl.getBoundingClientRect();
      setTarget({ top: r.top - 4, left: r.left - 6, width: r.width + 12, height: r.height + 8 });
      const below = r.bottom + 12;
      const top = below + h <= vh - GUTTER || r.top - 12 - h < GUTTER ? below : r.top - 12 - h;
      const left = Math.min(Math.max(GUTTER, r.left), vw - w - GUTTER);
      setPlace({ top, left });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  // Escape pauses. The latest handler, without re-running (and refocusing) on every render.
  const pauseRef = useRef(onPause);
  pauseRef.current = onPause;
  useEffect(() => {
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") pauseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {target ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded-lg ring-2 ring-gold shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
          style={target}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/35" />
      )}
      <div
        ref={card}
        role="dialog"
        aria-labelledby="orientation-title"
        aria-describedby="orientation-body"
        data-orientation={step.key}
        className="fixed z-50 w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-xl bg-white p-4 shadow-xl ring-1 ring-dust-light"
        style={place ?? { top: GUTTER, left: GUTTER, visibility: "hidden" }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2
            id="orientation-title"
            ref={heading}
            tabIndex={-1}
            className="font-semibold outline-none"
          >
            {step.title}
          </h2>
          <span className="shrink-0 text-xs text-charcoal">{position}</span>
        </div>
        <p id="orientation-body" className="text-sm">
          {step.body}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-3 text-sm text-charcoal">
            <button type="button" onClick={onPause} className="underline pointer-coarse:py-2">
              Pause
            </button>
            <button type="button" onClick={onStop} className="underline pointer-coarse:py-2">
              Stop tour
            </button>
          </div>
          <div className="flex gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className={`${btn.secondary} text-sm`}>
                Back
              </button>
            )}
            <button type="button" onClick={onNext} className={`${btn.primary} text-sm`}>
              {nextLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
