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
import { bytesToHex0x } from "./registryUtils";

describe("bytesToHex0x", () => {
  it("prefixes a hex-encoded byte string with 0x", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex0x(bytes)).toBe("0xdeadbeef");
  });

  it("returns 0x for an empty byte array", () => {
    expect(bytesToHex0x(new Uint8Array([]))).toBe("0x");
  });

  it("preserves leading zeros (a regression-prone case for naive impls)", () => {
    // Naive Number/BigInt round-trips would silently drop leading zeros.
    // Pin the byte-faithful behaviour.
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    expect(bytesToHex0x(bytes)).toBe("0x00000001");
  });
});
