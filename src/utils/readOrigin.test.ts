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
import { ss58Encode } from "@parity/product-sdk-address";
import { READ_ONLY_QUERY_ORIGIN } from "./readOrigin.ts";

// pallet-revive's keyless pallet account: `PalletId(*b"py/reviv")` →
// `b"modl" + b"py/reviv"` + 20 zero bytes, SS58-encoded with the default
// (substrate, prefix 42) format. Frozen here so a regression back to Alice (or
// any other dev-seed origin) fails loudly. Must match
// `@parity/product-sdk-contracts`' QUERY_FALLBACK_ORIGIN.
const EXPECTED_ORIGIN = "5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV";

describe("READ_ONLY_QUERY_ORIGIN", () => {
  it("is pallet-revive's keyless pallet account, not a dev-seed origin", () => {
    expect(READ_ONLY_QUERY_ORIGIN).toBe(EXPECTED_ORIGIN);
  });

  it("encodes the documented raw bytes (modl + py/reviv + zero padding)", () => {
    const pk = new Uint8Array(32);
    pk.set(new TextEncoder().encode("modlpy/reviv"));
    expect(ss58Encode(pk)).toBe(EXPECTED_ORIGIN);
  });
});
