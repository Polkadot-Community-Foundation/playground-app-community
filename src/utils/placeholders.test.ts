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
import { cardColorForDomain } from "./placeholders";

describe("cardColorForDomain", () => {
  it("returns the same colour for the same domain (deterministic)", () => {
    // Determinism is load-bearing: the grid renders one card per registry
    // entry, and each render re-derives the fill colour. A non-deterministic
    // result would cause icon-less cards to flicker between renders.
    const first = cardColorForDomain("example.dot");
    const second = cardColorForDomain("example.dot");
    expect(second).toBe(first);
  });

  it("returns a value from the --cat-* palette", () => {
    // Sanity: the function maps into the CSS custom-property palette, not an
    // arbitrary string. Catches a regression where the palette array changes
    // shape or the var() wrapper is dropped.
    const result = cardColorForDomain("example.dot");
    expect(result).toMatch(/^var\(--cat-[a-z]+\)$/);
  });

  it("distributes domains across multiple colours", () => {
    // The hash → index mapping must spread across the palette; otherwise every
    // icon-less card would share the same colour. Sampling 20 distinct domains
    // and counting distinct outputs is probabilistic — with 7 colours and a
    // reasonable hash, collisions down to <4 distinct would signal a bad hash.
    const domains = Array.from({ length: 20 }, (_, i) => `app-${i}.dot`);
    const results = new Set(domains.map(cardColorForDomain));
    expect(results.size).toBeGreaterThan(3);
  });

  it("handles the empty-domain edge case without throwing", () => {
    // Defensive: the util shouldn't trap on its own. The hash loop runs 0
    // times, so the modulo is `Math.abs(0) % N = 0` — first colour.
    expect(() => cardColorForDomain("")).not.toThrow();
    expect(cardColorForDomain("")).toMatch(/^var\(--cat-[a-z]+\)$/);
  });

  it("handles Unicode in the domain without throwing", () => {
    // The hash iterates charCodeAt — for surrogate pairs this reads each code
    // unit independently, which is fine (deterministic, not canonically
    // "right"). Guards against a future regression to codePointAt.
    expect(() => cardColorForDomain("café.dot")).not.toThrow();
    expect(() => cardColorForDomain("🎯.dot")).not.toThrow();
  });
});
