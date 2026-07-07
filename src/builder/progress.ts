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

// Within-step progress easing for StepProgress's active segment.
//
// The slow step in an upload/deploy is the broadcast / in-block wait, and the
// host SDK exposes NO sub-progress for it (preimageManager.submit is a single
// opaque await; see store.ts). So we can't show REAL granularity there. Instead
// we model EXPECTED progress against a typical step duration: an eased curve
// that moves fast early, then visibly slows as it climbs — so a step taking
// longer than usual reads as "still working, but slow" rather than "frozen".
//
// Two honesty guarantees:
//   1. It NEVER reaches 1 on its own (capped below 100%). The caller snaps to
//      done only when the step ACTUALLY advances, so the bar can't claim
//      completion the work hasn't reached.
//   2. The real completion/timeout is enforced elsewhere (withDeadline in
//      deadline.ts). This is purely a liveness cue, not a meter — by the time
//      the curve nears its cap, the operation is at/near its deadline anyway.

/** Time constant: the curve reaches ~63% of its cap at TAU. Tuned to the
 *  typical broadcast/in-block window (~6-12s), so it creeps steadily through
 *  the common case and is nearly flat by the SUBMIT deadline (45s). */
export const PROGRESS_TAU_MS = 9_000;

/** Hard ceiling the curve asymptotes toward but never reaches — leaves visible
 *  headroom so the bar is never full until the caller snaps it on real
 *  completion. */
export const PROGRESS_CAP = 0.92;

/**
 * Eased, asymptotic progress fraction in [0, PROGRESS_CAP).
 *
 * `elapsedMs` is time since the current step became active. Returns a value
 * that rises monotonically, fast at first then slowing, and is strictly less
 * than `cap` for any finite input.
 */
export function easedStepProgress(
  elapsedMs: number,
  tauMs: number = PROGRESS_TAU_MS,
  cap: number = PROGRESS_CAP,
): number {
  if (!(elapsedMs > 0)) return 0; // also catches NaN
  return cap * (1 - Math.exp(-elapsedMs / tauMs));
}
