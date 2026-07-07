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

import { ChevronDown } from "lucide-react";
import PrizeList from "./PrizeList";
import RewardLine from "./RewardLine";
import { XP_VALUES } from "./xpValues";
import { useSectionDisclosure } from "./utils";

/**
 * The XP & Prizes information card — the first text a visitor reads below the
 * hero island. It carries the core message (Playground rewards starting points,
 * not just apps), the XP-mechanics list, the prize breakdown, and the two
 * entry-point CTAs. `id="xp-prizes"` is the anchor the TOC and the Leaderboard
 * "How XP & Prizes work" link target.
 */
export default function XpPrizesSection() {
  // Collapsible, with the open/folded state remembered on this device (shared
  // store with the journey sections — see useSectionDisclosure). Default open.
  const { open, toggle } = useSectionDisclosure("xp-prizes", false);

  return (
    <section id="xp-prizes" className="xp-prizes" aria-labelledby="xp-prizes-title">
      <div className="xp-prizes-card">
        <header className="xp-prizes-head">
          <button
            type="button"
            className="xp-prizes-toggle"
            aria-expanded={open}
            aria-controls="xp-prizes-body"
            onClick={toggle}
          >
            <h2 id="xp-prizes-title" className="xp-prizes-title">
              XP &amp; Prizes
            </h2>
            <ChevronDown
              className={`journey-chevron${open ? " is-open" : ""}`}
              size={22}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        </header>

        <div
          id="xp-prizes-body"
          className={`journey-section-body${open ? "" : " is-collapsed"}`}
        >
          <div className="journey-section-body-inner xp-prizes-body-inner" inert={!open || undefined}>
            <p className="xp-prizes-lede">
              Build apps and earn XP. You earn even more when other people build on
              what you make.
            </p>

            <p className="xp-prizes-body">
              Join the Playground, build apps, and earn XP as you go. Launch your
              first projects, publish them on a{" "}
              <code className="inline-code">.dot</code> domain, and make them moddable
              so others can build from them. You earn XP whenever someone mods or stars
              your app. Explore what everyone else is making, star the apps you like,
              and compete for prizes.
            </p>

            <div className="xp-prizes-grid">
              <div className="xp-prizes-col">
                <h3 className="xp-prizes-subhead">Prizes</h3>
                <PrizeList />
              </div>
              <div className="xp-prizes-col">
                <h3 className="xp-prizes-subhead">How you earn XP</h3>
                <ul className="reward-list">
                  <RewardLine
                    title="Become a builder"
                    amount={XP_VALUES.identity}
                    condition="for setting up your builder identity"
                  />
                  <RewardLine
                    title="Deploy"
                    amount={XP_VALUES.deploy}
                    condition="for each of your first three deploys"
                  />
                  <RewardLine
                    title="Inspire"
                    amount={XP_VALUES.modReceived}
                    condition="each time someone mods your app"
                  />
                  <RewardLine
                    title="Go viral"
                    amount={XP_VALUES.starReceived}
                    condition="each time someone stars your app"
                  />
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
