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

import type { EventStreamSource } from "./eventStream";

export const LEADERBOARD_COUNTDOWN_EVENT_STREAM_SOURCE_ID = "leaderboard-countdown";
export const LEADERBOARD_COUNTDOWN_KIND = "registry-highlight.leaderboard-countdown";

// Friday 19 June 2026, 15:00 Central European clock time. Central Europe observes
// CEST (UTC+2) in June, so the absolute instant is 13:00 UTC. The displayed copy
// keeps the "15:00 CET" wording the team uses.
export const LEADERBOARD_DECISION_DEADLINE_MS = Date.parse("2026-06-19T13:00:00Z");
const LEADERBOARD_DECISION_LABEL = "15:00 CET on 19 June";

export interface LeaderboardCountdownPayload {
  deadline: number;
}

// Emits a single highlight that the ticker renders with a live countdown (see
// EventStream.tsx). The item carries the target timestamp in `payload`; the
// displayed text is recomputed at render time, so the same pooled item ticks
// down as the marquee scrolls. The `title` here is the static fallback used for
// accessibility and if the live formatter is ever bypassed.
export function createLeaderboardCountdownEventStreamSource(): EventStreamSource {
  return {
    id: LEADERBOARD_COUNTDOWN_EVENT_STREAM_SOURCE_ID,
    label: "Leaderboard countdown",
    connect({ emit }) {
      emit<LeaderboardCountdownPayload>({
        id: "leaderboard-countdown:summit-2026-06-19",
        kind: LEADERBOARD_COUNTDOWN_KIND,
        category: "leaderboard",
        tone: "positive",
        title: `Winners at ${LEADERBOARD_DECISION_LABEL}`,
        entities: [],
        payload: { deadline: LEADERBOARD_DECISION_DEADLINE_MS },
      });
    },
  };
}
