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

import { type CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { QUEST_COLORS } from "./questPalette";
import { useOnboarding } from "./OnboardingProvider";

/**
 * The Apps-page onboarding banner. Resembles a journey card — hue-tinted, with
 * a single arrow CTA — and runs full-width above the grid and rail. The caller
 * (AppsTab) renders it only when connected and `!hasResources`; it disappears
 * the moment resources land.
 */
export default function BecomeBuilderCard() {
  const { startBecomeBuilder } = useOnboarding();

  return (
    <button
      type="button"
      className="become-builder-card"
      style={{ "--journey-hue": QUEST_COLORS.character } as CSSProperties}
      onClick={() => startBecomeBuilder()}
      data-testid="become-builder-card"
    >
      <span className="become-builder-card-text">
        <span className="become-builder-card-title">Become a builder</span>
        <span className="become-builder-card-sub">
          Get set up to publish, star, and mod apps on Polkadot.
        </span>
      </span>
      <span className="become-builder-card-arrow" aria-hidden="true">
        <ArrowRight size={20} strokeWidth={2.5} />
      </span>
    </button>
  );
}
