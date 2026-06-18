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

// Chain caps as plain constants — dependency-free so UI code can import them
// without dragging the PAPI client/descriptors into the initial bundle.

/** Per-transaction chain cap — applies regardless of account authorization. */
export const MAX_TX_BYTES = 2 * 1024 * 1024; // 2 MiB on Paseo Next (8 MiB on Polkadot Bulletin)

// Registry-listing metadata caps. The fields are free-form off-chain (the
// contract validates none of them), so these are UI/layout bounds: they keep
// auto-filled or pasted values from overflowing the Apps card + detail page.
// One source of truth for both the prefill truncation and the input maxLength.
/** Max length of an app's display name (card title). */
export const LISTING_NAME_MAX = 60;
/** Max length of the short description (and the readme it seeds). */
export const LISTING_DESC_MAX = 160;
