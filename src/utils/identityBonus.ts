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

// Per-account local record that the one-time identity bonus (the 25 XP intro
// award) has been earned — by becoming a builder (the bundled `set_identity`).
// The registry tracks this on-chain in `identity_bonus_awarded` but exposes NO
// public getter, so we record it locally the moment this device completes the
// flow or sees an `IdentityBonusAwarded` event for the account, painting the
// "Become a builder" achievement complete without waiting on a chain read.
//
// A revealed identity is also detectable via the root read, so this local flag
// is mostly a fast-path/optimistic signal.

const KEY = "pg.identityBonus.v1";

function readFile(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Whether this device has recorded the intro bonus for `addr`. */
export function readIdentityBonusClaimed(addr: string): boolean {
  return readFile()[addr.toLowerCase()] === true;
}

/** Record that `addr` earned the one-time intro bonus. Idempotent; never clears. */
export function markIdentityBonusClaimed(addr: string): void {
  const key = addr.toLowerCase();
  try {
    const file = readFile();
    if (file[key]) return;
    file[key] = true;
    localStorage.setItem(KEY, JSON.stringify(file));
  } catch {
    /* storage full / unavailable — this is a display optimisation only */
  }
}
