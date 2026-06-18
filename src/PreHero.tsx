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

import { useEffect, useRef } from "react";

const SEEN_KEY = "playground:prehero-seen.v1";

/**
 * Has this device already seen the pre-hero intro? Read synchronously by the
 * Playground tab so the very first frame is correct (no flash). Any storage
 * failure (private mode, quota) is treated as "not seen" — showing it again is
 * harmless, throwing is not.
 */
export function hasSeenPreHero(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the intro as seen for this device. Storage failures are swallowed. */
function markPreHeroSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode / quota — the intro just shows once more next time */
  }
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * One-time intro shown above the hero island on a device's first Playground
 * visit: a big headline that fades out as you scroll past it. Renders two
 * siblings (never wrappers) of <IslandPortal> so the island's
 * `mix-blend-mode: lighten` keeps a clean ancestor chain: a `.prehero-spacer`
 * that gives the island room above, and a fixed `.prehero-text` overlay.
 */
export default function PreHero() {
  const textRef = useRef<HTMLDivElement>(null);

  // Showing it counts as seen — returning visitors land straight on the island.
  useEffect(() => {
    markPreHeroSeen();
  }, []);

  // Fade the headline out on scroll distance, so the bright text never lifts in
  // front of the rising island (its `mix-blend-mode: lighten`). Driven purely by
  // `window.scrollY` — NOT the island's measured position: on mobile the island
  // gets pinned (freezing its rect) and dynamic-viewport toolbar collapse shifts
  // it, both of which stall a measurement-based fade. scrollY is monotonic and
  // layout-independent. Hold briefly at the top, fully gone by ~55% of a screen.
  useEffect(() => {
    let frame = 0;
    const apply = () => {
      frame = 0;
      const el = textRef.current;
      if (!el) return;
      const vh = window.innerHeight;
      const fadeStart = vh * 0.12;
      const fadeEnd = vh * 0.3;
      const progress = clamp(
        (window.scrollY - fadeStart) / (fadeEnd - fadeStart),
        0,
        1,
      );
      el.style.opacity = String(1 - progress);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div className="prehero-spacer" aria-hidden="true" />
      <div className="prehero-text" ref={textRef}>
        <div className="prehero-text-col">
          <h1 className="prehero-title">
            Build web3 apps <em>&amp; win prizes</em>
          </h1>
        </div>
      </div>
    </>
  );
}
