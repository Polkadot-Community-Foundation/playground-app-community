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

const PRIZES: Array<{ title: string; award: string; basis: string }> = [
  {
    title: "Leaderboard winners",
    award: "€1000 / €500 / €250",
    basis: "for the top XP scores",
  },
  { title: "Builders' favourite", award: "€1000", basis: "for the most modded app" },
  { title: "Crowd favourite", award: "€1000", basis: "for the most starred app" },
  { title: "Innovation wildcards", award: "2 × €500", basis: "judges' pick at the venue" },
];

/**
 * Compact, scannable prize list shown inside the XP & Prizes card.
 */
export default function PrizeList() {
  return (
    <ul className="prize-list">
      {PRIZES.map((p) => (
        <li key={p.title} className="prize-row">
          <span className="prize-text">
            <span className="prize-title">{p.title}</span>
            <span className="prize-basis">{p.basis}</span>
          </span>
          <span className="prize-award">{p.award}</span>
        </li>
      ))}
    </ul>
  );
}
