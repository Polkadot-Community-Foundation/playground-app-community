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

import XpLabel from "./XpLabel";

type Props = {
  /** Guild / rank-like noun for the user's role, e.g. "Novice". */
  title: string;
  amount: number;
  upTo?: boolean;
  /** Condition text, kept outside the XP label for scannability. */
  condition: string;
};

/**
 * One row of the XP-mechanics list: a rank-like title, the XP amount in its own
 * label, and the condition alongside it. Used in the XP & Prizes card.
 */
export default function RewardLine({ title, amount, upTo, condition }: Props) {
  return (
    <li className="reward-line">
      <span className="reward-line-title">{title}</span>
      <XpLabel amount={amount} upTo={upTo} />
      <span className="xp-note">{condition}</span>
    </li>
  );
}
