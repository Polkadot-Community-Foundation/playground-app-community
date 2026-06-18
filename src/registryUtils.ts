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

// Side-effect-free helpers for the registry-domain code in App.tsx. Lives
// separately so unit tests can import without pulling chain-init side
// effects from the App module's transitive imports.

import { bytesToHex } from "@parity/product-sdk-utils";

export type Hex32 = `0x${string}`;

/**
 * Prefix a hex-encoded byte string with `0x`. Matches the
 * `@parity/product-sdk-contracts` ≥ 0.4 expectation that bytes32 args
 * arrive as `0x`-prefixed `SizedHex<N>` strings rather than the SDK's
 * lenient runtime-decode shapes.
 */
export function bytesToHex0x(bytes: Uint8Array): Hex32 {
  return `0x${bytesToHex(bytes)}` as Hex32;
}
