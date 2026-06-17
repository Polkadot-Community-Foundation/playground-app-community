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

// Pure decision predicate for the deploy preflight's PGAS sufficiency check.
// Kept in its own leaf module (importing only the floor constant + a type) so
// it stays unit-testable without pulling preflight.ts's chain/dotns graph.

import type { AccountSource } from "./account.ts";
import { MIN_PGAS } from "../utils/fundsFloors.ts";

/** Host accounts pay contract-call fees from PGAS (AsPgas sponsorship), so a
 *  deploy's registry/DotNS calls can fail on fees even when the native balance
 *  (which covers deposits) is fine. Warn when PGAS is low-but-nonzero: a ZERO
 *  balance self-heals at deploy (ensureSignerReady requests SmartContractAllowance
 *  → ~50B drip) because its `hasPgasOnChain` gate only skips on balance > 0; a
 *  low-but-nonzero balance is skipped by that gate and won't be topped up.
 *  `null` (read failed) → no warn (preflight is advisory; deploy re-verifies).
 *  Dev accounts pay native fees directly and use no PGAS — never warned. */
export function pgasShortfallWarn(source: AccountSource, pgas: bigint | null): boolean {
  return source === "host" && pgas !== null && pgas > 0n && pgas < MIN_PGAS;
}
