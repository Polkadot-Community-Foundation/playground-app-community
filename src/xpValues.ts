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

/**
 * Final XP amounts per the absolute-value scoring model (issue #286). Single
 * source of truth for every surface that names an XP reward — the IslandPortal
 * quest stickers, the XpPrizesSection reward list, and the per-step
 * JourneySection rewards in PlaygroundTab. Editing one number here updates
 * every place a user might see it.
 *
 * Caveat: the live `island-xp-n` counter reads raw `account_points` from the
 * contract. Until the v14 redeploy lands (issues #287 / #288 / #289), the
 * counter will tick by the contract's pre-redeploy values — these constants
 * reflect what the contract WILL award, not what it does today.
 */
export const XP_VALUES = {
  /** One-time, awarded on first verified identity bind (set_identity). */
  identity: 25,
  /**
   * Each of the owner's first three awarded deploys (#288), regardless of
   * public/private visibility; later deploys = 0. Deploys that award nothing
   * (dev-signer, blacklisted recipient) don't consume a slot.
   */
  deploy: 100,
  /** Per unique modder per source-app (deduped by `(modder, source)`). */
  modReceived: 50,
  /** Per star received. Star is one-way: no XP to the star giver. */
  starReceived: 10,
} as const;
