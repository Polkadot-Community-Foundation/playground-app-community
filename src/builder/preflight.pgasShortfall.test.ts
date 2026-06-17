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
import { pgasShortfallWarn } from "./pgasShortfall.ts";

// MIN_PGAS = 5_000_000_000n (from ../utils/fundsFloors.ts)
describe("pgasShortfallWarn", () => {
  it("warns a host account with low-but-nonzero PGAS", () => {
    expect(pgasShortfallWarn("host", 1_000_000_000n)).toBe(true);
    expect(pgasShortfallWarn("host", 4_999_999_999n)).toBe(true);
  });
  it("does NOT warn a host account with zero PGAS (deploy provisions it)", () => {
    expect(pgasShortfallWarn("host", 0n)).toBe(false);
  });
  it("does NOT warn a host account at/above the floor", () => {
    expect(pgasShortfallWarn("host", 5_000_000_000n)).toBe(false);
    expect(pgasShortfallWarn("host", 50_000_000_000n)).toBe(false);
  });
  it("does NOT warn on a failed read (null)", () => {
    expect(pgasShortfallWarn("host", null)).toBe(false);
  });
  it("never warns a dev account", () => {
    expect(pgasShortfallWarn("dev", 1n)).toBe(false);
    expect(pgasShortfallWarn("dev", null)).toBe(false);
  });
});
