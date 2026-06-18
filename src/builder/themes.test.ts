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

import { describe, expect, it } from "vitest";
import { pickRandomTheme, THEME_COMBOS } from "./themes.ts";

const key = (c: { accentColor: string; background: string; fontFamily: string }) =>
    `${c.accentColor}|${c.background}|${c.fontFamily}`;

describe("pickRandomTheme", () => {
    it("never returns the combo currently applied", () => {
        // Run from every combo many times — repeated taps must always change.
        for (const current of THEME_COMBOS) {
            for (let i = 0; i < 200; i++) {
                expect(key(pickRandomTheme(current))).not.toBe(key(current));
            }
        }
    });

    it("only returns combos from the curated list", () => {
        const known = new Set(THEME_COMBOS.map(key));
        for (let i = 0; i < 200; i++) {
            expect(known.has(key(pickRandomTheme(THEME_COMBOS[0])))).toBe(true);
        }
    });

    it("matches the current combo on accent + background + font only", () => {
        // A combo that shares accent/bg/font but differs only by an unrelated
        // field is still treated as 'current' and excluded.
        const current = { ...THEME_COMBOS[0], textColor: "#abcdef" };
        for (let i = 0; i < 200; i++) {
            expect(key(pickRandomTheme(current))).not.toBe(key(THEME_COMBOS[0]));
        }
    });
});
