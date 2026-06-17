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
 * Quest colour coding, keyed by quest id. The single source of truth shared by
 * the IslandPortal hotspots/quest windows and the Playground journey sections,
 * so a hue tweak follows everywhere it's used.
 */
export const QUEST_COLORS = {
  character: "#4BA3FF", // Username
  gates: "#FF4B90", // Your site on .dot domain
  underground: "#41FF8D", // Game app tutorial
  lights: "#FF420E", // Mod an app
  star: "#7FE2F0", // Give and receive stars
  pet: "#F0E27F", // App modded
} as const;
