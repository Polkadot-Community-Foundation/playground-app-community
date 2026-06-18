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

import { describe, it, expect } from "vitest";
import { easedStepProgress, PROGRESS_CAP, PROGRESS_TAU_MS } from "./progress.ts";

describe("easedStepProgress", () => {
  it("starts at zero and treats non-positive / NaN elapsed as zero", () => {
    expect(easedStepProgress(0)).toBe(0);
    expect(easedStepProgress(-100)).toBe(0);
    expect(easedStepProgress(Number.NaN)).toBe(0);
  });

  // The core honesty guarantee: the bar must NEVER fill on its own. Across the
  // whole operational window (elapsed is bounded by the ~45s SUBMIT deadline,
  // tested well past it) it's STRICTLY below the cap — still visibly climbing,
  // never claiming a completion the upload hasn't reached. The caller alone
  // snaps to done on real step advance.
  it("stays strictly below the cap across the operational window", () => {
    for (const ms of [1_000, 9_000, 45_000, 120_000, 300_000]) {
      expect(easedStepProgress(ms)).toBeLessThan(PROGRESS_CAP);
    }
  });

  // And is mathematically bounded by the cap for ANY input (the curve only
  // touches it in the float-underflow limit, far beyond any real elapsed), so
  // the rendered width — round(fraction * 100) — can never reach 100%.
  it("never exceeds the cap, even at absurd elapsed", () => {
    for (const ms of [600_000, 1e9, Number.MAX_SAFE_INTEGER]) {
      expect(easedStepProgress(ms)).toBeLessThanOrEqual(PROGRESS_CAP);
    }
    expect(Math.round(easedStepProgress(1e9) * 100)).toBeLessThan(100);
  });

  it("rises monotonically and decelerates (eased, not linear)", () => {
    const a = easedStepProgress(3_000);
    const b = easedStepProgress(6_000);
    const c = easedStepProgress(9_000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    // First 3s gains more than the next 3s — the curve slows as it climbs.
    expect(b - a).toBeLessThan(a);
  });

  it("reaches ~63% of the cap at one time constant", () => {
    expect(easedStepProgress(PROGRESS_TAU_MS)).toBeCloseTo(PROGRESS_CAP * 0.632, 2);
  });
});
