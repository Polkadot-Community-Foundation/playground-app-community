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

// Minimum on-screen time for the deploy panel's "Checking…" state.
//
// A pre-flight whose checks resolve within the click's own microtask flush
// (an instant reject on a wedged socket, or a cached availability result)
// would otherwise flip busy→false before the browser ever paints busy→true,
// so the tap looks inert. The deploy panel holds the busy state for at least
// this long — clearing it via a macrotask (setTimeout) so a paint lands first
// — which gives every check tap visible feedback regardless of how fast the
// underlying check returned.
export const MIN_CHECK_VISIBLE_MS = 400;

/**
 * How long to keep "Checking…" up after a pre-flight resolves, given how long
 * it actually ran (`elapsedMs`).
 *
 * - A check that resolved faster than the floor → the remaining time, so the
 *   state stays visible long enough to paint and read.
 * - A check that already ran at/over the floor → 0 (clear immediately; it was
 *   on screen the whole time). Never negative.
 */
export function checkBusyClearDelay(elapsedMs: number): number {
    return Math.max(0, MIN_CHECK_VISIBLE_MS - elapsedMs);
}
