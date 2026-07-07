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

import { ss58Encode } from "@parity/product-sdk-address";

/**
 * Origin for every read-only query dry-run: pallet-revive's own keyless pallet
 * account, mirroring `Pallet::<T>::account_id()` —
 * `PalletId(*b"py/reviv").into_account_truncating()`, i.e. the PalletId
 * `TYPE_ID` (`b"modl"`) + `b"py/reviv"` + 20 trailing zero bytes. This is the
 * same value `@parity/product-sdk-contracts` uses as its `QUERY_FALLBACK_ORIGIN`
 * when no origin is configured.
 *
 * We pass it explicitly (rather than relying on that fallback) because the SDK
 * still logs a per-query `"No origin configured"` warning when it falls back —
 * passing the origin keeps that warning out of the browser console / Sentry
 * breadcrumbs on every registry read.
 *
 * Deliberately separate from user transaction signing so public reads do not
 * depend on the connected product account, and — unlike the old
 * `DEV_PHRASE`-derived origin — not tied to any dev mnemonic: it is
 * semantically neutral and always exists on chain.
 *
 * Lifted out of `contracts.ts` so vitest can import + freeze the derived SS58
 * without dragging in that module's eager `contractsReady` bootstrap.
 *
 * TODO: drop this derivation and import `QUERY_FALLBACK_ORIGIN` from
 * `@parity/product-sdk-contracts` directly. The export already landed upstream
 * (product-sdk commit 2aec812) but isn't in a published release yet — the
 * latest is 0.7.7, which neither exports the constant nor suppresses the
 * warning. Swap once a release ships both.
 */
const REVIVE_PALLET_PUBLIC_KEY = new Uint8Array(32);
REVIVE_PALLET_PUBLIC_KEY.set(new TextEncoder().encode("modlpy/reviv"));

export const READ_ONLY_QUERY_ORIGIN = ss58Encode(REVIVE_PALLET_PUBLIC_KEY);
