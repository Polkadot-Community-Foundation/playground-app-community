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

import {
  EventStreamStore,
  useEventStream,
  type UseEventStreamOptions,
} from "./eventStream";
import { createRegistryHighlightsEventStreamSource } from "./registryHighlightsEventStreamSource";
import { createRegistryEventStreamSource } from "./registryEventStreamSource";
import { createLeaderboardCountdownEventStreamSource } from "./leaderboardCountdownEventStreamSource";

export const playgroundEventStream = new EventStreamStore({ maxItems: 300 });

playgroundEventStream.registerSource(createRegistryEventStreamSource());
playgroundEventStream.registerSource(createRegistryHighlightsEventStreamSource());
playgroundEventStream.registerSource(createLeaderboardCountdownEventStreamSource());

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    playgroundEventStream.dispose();
  });
}

export function usePlaygroundEventStream(options: UseEventStreamOptions = {}) {
  return useEventStream(playgroundEventStream, options);
}

export type {
  EventStreamCategory,
  EventStreamEntity,
  EventStreamInput,
  EventStreamItem,
  EventStreamSource,
  EventStreamTone,
  EventStreamUnsubscribe,
  UseEventStreamOptions,
} from "./eventStream";
