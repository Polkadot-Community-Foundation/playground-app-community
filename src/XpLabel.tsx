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

import { useState } from "react";

type Props = {
  /** XP amount as a number, e.g. 50 → renders "+50 XP". */
  amount: number;
  /** Prefix the label with "up to" (e.g. the curator star cap). */
  upTo?: boolean;
};

/**
 * The scannable `+N XP` amount in its own tilted chip. The optional "up to"
 * qualifier sits *outside* the chip as a sibling note, sharing the `.xp-note`
 * class with the clarifying condition the parent renders on the other side —
 * so both qualifiers around the chip read identically.
 *
 * The chip gets a small random tilt for a hand-stuck-sticker feel, rolled once
 * per mount so it stays put across re-renders (no jitter).
 */
export default function XpLabel({ amount, upTo }: Props) {
  const [rotation] = useState(() => Math.random() * 10 - 5);
  return (
    <span className="xp-label-group">
      {upTo && <span className="xp-note">up to</span>}
      <span className="xp-label" style={{ transform: `rotate(${rotation}deg)` }}>
        +{amount} XP
      </span>
    </span>
  );
}
