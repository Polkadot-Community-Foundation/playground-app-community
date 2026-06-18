// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { useRef, useEffect, useState, type RefObject } from "react";

/**
 * Cycle through `messages` on a fixed interval — for playful "still working"
 * loaders where a single static line would feel stuck. Returns the current
 * message plus its index (key a crossfade off the index). Resets to the first
 * message whenever the list identity changes, and clears its timer on unmount.
 */
export function useRotatingMessage(
  messages: readonly string[],
  intervalMs: number = 2200,
): { text: string; index: number } {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (messages.length <= 1) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % messages.length),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [messages, intervalMs]);

  return { text: messages[index] ?? messages[0] ?? "", index };
}

// Per-section folded state, remembered on this device so a manual fold/unfold
// (and the self-attest fold) survives reload. Keyed by section id.
const FOLD_KEY = "pg.journeyFolded.v1";

function readFoldedFile(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLD_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function writeFolded(id: string, folded: boolean): void {
  try {
    const file = readFoldedFile();
    file[id] = folded;
    localStorage.setItem(FOLD_KEY, JSON.stringify(file));
  } catch {
    /* private-mode / quota — fold state just stays session-only */
  }
}

/**
 * Open/collapsed state for a journey section. A stored fold preference (this
 * device) wins over `initialCollapsed`, which is otherwise captured once at
 * mount — a completion resolving mid-session must NOT yank the card shut under
 * the reader. Every open-state change is persisted so a manual fold/unfold
 * survives reload. Listens for "pg:open-section" (anchor navigation — deep
 * links land on an expanded card).
 */
export function useSectionDisclosure(
  id: string,
  initialCollapsed: boolean,
): { open: boolean; toggle: () => void } {
  // Lazy init so the restored state is in the first frame (no fold flash).
  const [open, setOpen] = useState(() => {
    const stored = readFoldedFile()[id];
    return stored !== undefined ? !stored : !initialCollapsed;
  });

  // Remember the folded state on this device whenever it changes.
  useEffect(() => {
    writeFolded(id, !open);
  }, [id, open]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setOpen(true);
    };
    window.addEventListener("pg:open-section", onOpen);
    return () => window.removeEventListener("pg:open-section", onOpen);
  }, [id]);

  return { open, toggle: () => setOpen((o) => !o) };
}

// One-shot device flag: set the first time the build gate opens, so the
// auto-expand below never fights a later manual collapse.
const UNLOCK_EXPANDED_KEY = "pg.journeyUnlockExpanded.v1";

function readUnlockExpanded(): boolean {
  try {
    return localStorage.getItem(UNLOCK_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeUnlockExpanded(): void {
  try {
    localStorage.setItem(UNLOCK_EXPANDED_KEY, "1");
  } catch {
    /* private-mode / quota — auto-expand just re-runs next unlock check */
  }
}

/**
 * The first time `unlocked` becomes true, open each gated journey section once
 * via the "pg:open-section" event (the same channel deep links use), then set a
 * device flag so a later manual collapse is never re-opened on a subsequent
 * check or reload. `ids` should already exclude completed steps — those stay
 * folded. Fires on the live false→true transition and when the gate is already
 * open on first load (the section listeners mount before this parent effect).
 */
export function useUnlockExpand(unlocked: boolean, ids: readonly string[]): void {
  useEffect(() => {
    if (!unlocked || readUnlockExpanded()) return;
    for (const id of ids) {
      window.dispatchEvent(new CustomEvent("pg:open-section", { detail: id }));
    }
    writeUnlockExpanded();
  }, [unlocked, ids]);
}

// Reactive viewport check matching the app's primary 820px breakpoint (and the
// `window.innerWidth <= 820` mobile test used for desktop window positioning).
export const MOBILE_QUERY = "(max-width: 820px)";

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export function useIntersectionObserver(
  onIntersect: () => void,
  enabled: boolean,
) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onIntersect(); },
      { threshold: 0.1, rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onIntersect, enabled]);

  return ref;
}

/**
 * True when the document scrolls vertically (content taller than the viewport).
 * The SPA shell scrolls the document, so we compare the root element's
 * scrollHeight to its clientHeight. Re-checks on resize and on any content
 * size change via a ResizeObserver — so end-of-list chrome can be hidden when
 * everything already fits on screen (nothing to scroll back from).
 */
export function usePageHasOverflow(): boolean {
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    // +1 tolerance for sub-pixel rounding.
    const check = () => setHasOverflow(root.scrollHeight > root.clientHeight + 1);
    check();
    window.addEventListener("resize", check);
    const ro = new ResizeObserver(check);
    ro.observe(root);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("resize", check);
      ro.disconnect();
    };
  }, []);

  return hasOverflow;
}

/** Tuning for {@link useKioskAutoScroll}. Times in ms, speed in px/sec. */
export interface KioskAutoScrollOptions {
  speed?: number;
  startPauseMs?: number;
  topPauseMs?: number;
  bottomPauseMs?: number;
  resumeDelayMs?: number;
}

const KIOSK_AUTOSCROLL_DEFAULTS = {
  speed: 36, // px/sec — slow enough to read from across a room
  startPauseMs: 6000, // dwell on the top before the first pass begins
  topPauseMs: 2500, // dwell at the top before each later pass (also covers the smooth rewind)
  bottomPauseMs: 3500, // dwell at the bottom before rewinding
  resumeDelayMs: 5000, // after a manual scroll/tap, wait this long before auto-resuming
};

/**
 * Slowly auto-scroll an element on a loop so a board can run unattended on a
 * venue screen: dwell on top → glide down → dwell at the bottom → smooth-rewind
 * to the top → repeat. Disabled under prefers-reduced-motion. Yields to (and
 * resumes shortly after) any manual scroll/tap so it stays usable as a plain view.
 *
 * @param ref      the scroll container to drive
 * @param enabled  run only when true (e.g. fullscreen && content loaded)
 * @param resetKey changing this re-seeds the loop — pass a value that changes when
 *                 the content height grows (e.g. row count) so it restarts cleanly
 * @param opts     override speed / dwell timings
 */
export function useKioskAutoScroll(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  resetKey?: unknown,
  opts?: KioskAutoScrollOptions,
) {
  const speed = opts?.speed ?? KIOSK_AUTOSCROLL_DEFAULTS.speed;
  const startPauseMs = opts?.startPauseMs ?? KIOSK_AUTOSCROLL_DEFAULTS.startPauseMs;
  const topPauseMs = opts?.topPauseMs ?? KIOSK_AUTOSCROLL_DEFAULTS.topPauseMs;
  const bottomPauseMs = opts?.bottomPauseMs ?? KIOSK_AUTOSCROLL_DEFAULTS.bottomPauseMs;
  const resumeDelayMs = opts?.resumeDelayMs ?? KIOSK_AUTOSCROLL_DEFAULTS.resumeDelayMs;

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return; // nothing to scroll yet
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let rafId = 0;
    let last = 0; // timestamp of the previous frame (RAF ms; 0 = not yet seeded)
    let phase: "scroll" | "pauseBottom" | "rewind" | "pauseTop" = "pauseTop";
    let phaseUntil = 0; // RAF timestamp at which the current dwell ends; 0 = needs seeding
    let lastInteract = -Infinity; // last manual scroll/tap (perf.now ms)
    // Float accumulator for the scroll position: scrollTop rounds to an integer
    // on most displays, so a ~0.6px/frame step would truncate to zero and never
    // move. We keep the true sub-pixel position here and assign scrollTop from it.
    let pos = el.scrollTop;

    const noteInteract = () => { lastInteract = performance.now(); };
    // Listen on the scroller (passive) plus window keys so any manual nudge pauses.
    el.addEventListener("wheel", noteInteract, { passive: true });
    el.addEventListener("touchstart", noteInteract, { passive: true });
    el.addEventListener("pointerdown", noteInteract);
    window.addEventListener("keydown", noteInteract);

    const tick = (t: number) => {
      rafId = requestAnimationFrame(tick);
      const prev = last;
      last = t;
      if (!prev) return; // first frame: just seed `last`, no delta yet
      // Someone touched it — yield, resync to where they left it, restart on idle.
      if (t - lastInteract < resumeDelayMs) { phase = "scroll"; pos = el.scrollTop; return; }

      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 1) return; // content fits — nothing to scroll

      if (phase === "pauseBottom") { if (t >= phaseUntil) phase = "rewind"; return; }
      if (phase === "rewind") {
        el.scrollTo({ top: 0, behavior: "smooth" });
        pos = 0;
        phase = "pauseTop";
        phaseUntil = t + topPauseMs;
        return;
      }
      if (phase === "pauseTop") {
        // First dwell (phaseUntil unseeded) lingers longer so the top rows read.
        if (phaseUntil === 0) phaseUntil = t + startPauseMs;
        if (t >= phaseUntil) phase = "scroll";
        return;
      }

      // scroll phase
      if (el.scrollTop >= maxScroll - 1) {
        phase = "pauseBottom";
        phaseUntil = t + bottomPauseMs;
        return;
      }
      pos += (speed * (t - prev)) / 1000;
      el.scrollTop = pos;
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener("wheel", noteInteract);
      el.removeEventListener("touchstart", noteInteract);
      el.removeEventListener("pointerdown", noteInteract);
      window.removeEventListener("keydown", noteInteract);
    };
  }, [enabled, resetKey, ref, speed, startPauseMs, topPauseMs, bottomPauseMs, resumeDelayMs]);
}
