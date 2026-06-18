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
import { checkBusyClearDelay, MIN_CHECK_VISIBLE_MS } from "./checkVisibility.ts";

describe("checkBusyClearDelay", () => {
    // The regression this guards: a pre-flight that resolves within the
    // click's own microtask flush (instant reject / cached result) must STILL
    // keep "Checking…" on screen long enough to paint — otherwise the tap
    // looks inert. So a fast check owes the remainder of the floor.
    it("holds the full floor when the check resolved instantly", () => {
        expect(checkBusyClearDelay(0)).toBe(MIN_CHECK_VISIBLE_MS);
    });

    it("owes the remaining floor for a check faster than the window", () => {
        expect(checkBusyClearDelay(100)).toBe(MIN_CHECK_VISIBLE_MS - 100);
        expect(checkBusyClearDelay(MIN_CHECK_VISIBLE_MS - 1)).toBe(1);
    });

    // A check that was already on screen for the whole window clears at once —
    // and the delay must never go negative (a negative setTimeout would fire
    // immediately, but returning <0 would be a lie about the intent).
    it("clears immediately once the floor has elapsed", () => {
        expect(checkBusyClearDelay(MIN_CHECK_VISIBLE_MS)).toBe(0);
    });

    it("never returns a negative delay for a slow check", () => {
        expect(checkBusyClearDelay(MIN_CHECK_VISIBLE_MS + 5_000)).toBe(0);
    });
});
