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
 * Maps a decoded registry event to the XP-celebration confetti shown when the
 * CONNECTED USER earns XP. Pure so it can be unit-tested without the event
 * stream; the App-level listener calls it for events that already passed the
 * "concerns me" filter (see src/App.tsx) and pops <XpCelebration> when it
 * returns non-null.
 *
 * Amounts come from the single source of truth in xpValues.ts. Only the award
 * events the live contract actually emits map to a celebration; legacy/no-op
 * names and any score-decreasing event (pointDelta !== 1, e.g.
 * StarPointRefunded) return null so we never celebrate a loss or an amount we
 * can't price.
 */

import type { DecodedRegistryEvent } from "./utils/event-stream/registryEvents";
import { XP_VALUES } from "./xpValues";

export interface XpCelebrationSpec {
  xp: number;
  label: string;
}

export function celebrationForEvent(
  event: Pick<DecodedRegistryEvent, "name" | "pointDelta">,
): XpCelebrationSpec | null {
  // A non-award delta (refund) never celebrates, even for a known name.
  if (event.pointDelta !== 1) return null;

  switch (event.name) {
    case "DeployPointAwarded":
    case "PlaygroundPublishPointAwarded":
      return { xp: XP_VALUES.deploy, label: "Site deployed!" };
    case "ModPointAwarded":
      return { xp: XP_VALUES.modReceived, label: "Someone modded your app!" };
    case "StarPointAwarded":
      return { xp: XP_VALUES.starReceived, label: "Someone starred your app!" };
    case "IdentityBonusAwarded":
      return { xp: XP_VALUES.identity, label: "You're a builder!" };
    default:
      // Includes ModdablePointAwarded (legacy +1 bucket, unpriced and no longer
      // emitted) and every non-points event.
      return null;
  }
}
