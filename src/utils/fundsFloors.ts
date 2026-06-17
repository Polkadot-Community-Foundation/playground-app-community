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

// Funds-gate constants — a dependency-free leaf module. Kept separate from
// balances.ts (which imports the chain client) so pure consumers — e.g. the
// builder's `pgasShortfallWarn` predicate and its unit test — can read the
// floors without pulling the chain graph (and triggering a connect at import).

// PGAS — the sufficient asset on Asset Hub that pays product-account txs.
export const PGAS_ASSET_ID = 2_000_000_000;

// Timeout shared across all bounded balance reads — same cap as the original
// hasPgasOnChain, for the same reason (wedged Android WebView sockets).
export const PGAS_QUERY_TIMEOUT_MS = 15_000;

// Native PAS floor (10 decimals) — 0.3 PAS. PGAS floor — 5B units (~10% of a
// 50B drip; covers several worst-case writes). A write is allowed if EITHER
// clears its floor: host/product accounts pay fees in PGAS, others in native PAS.
export const MIN_NATIVE_PLANCK = 3_000_000_000n;
export const MIN_PGAS = 5_000_000_000n;
