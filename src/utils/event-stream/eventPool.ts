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

import { type EventStreamItem } from "./eventStream";

export interface EventStreamPoolOptions {
  limit?: number;
  excludeKinds?: readonly string[];
  order?: "newest-first" | "oldest-first";
}

export interface LoopingEventStreamPoolOptions {
  itemCount?: number;
}

export interface EventStreamReplayCursor {
  laneIndex: number;
  itemIndexes: Record<string, number>;
}

const REGISTRY_HIGHLIGHTS_SOURCE_ID = "registry-highlights";
const RECENT_PUBLISH_HIGHLIGHT_KIND = "registry-highlight.recent-publish";
const REPLAY_LANE_ORDER = [
  "live",
  "highlight",
  "highlight:recent-publish",
] as const;

function replayLaneFor(item: EventStreamItem): (typeof REPLAY_LANE_ORDER)[number] {
  if (item.kind === RECENT_PUBLISH_HIGHLIGHT_KIND) return "highlight:recent-publish";
  if (
    item.source === REGISTRY_HIGHLIGHTS_SOURCE_ID ||
    item.kind.startsWith("registry-highlight.")
  ) {
    return "highlight";
  }
  return "live";
}

export function createEventStreamPool(
  items: readonly EventStreamItem[],
  options: EventStreamPoolOptions = {},
): readonly EventStreamItem[] {
  const excludedKinds = options.excludeKinds ? new Set(options.excludeKinds) : null;
  const limit = options.limit ?? items.length;
  if (limit <= 0) return [];

  const seenIds = new Set<string>();
  const pool: EventStreamItem[] = [];

  for (const item of items) {
    if (excludedKinds?.has(item.kind) || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    pool.push(item);
    if (pool.length >= limit) break;
  }

  return options.order === "oldest-first" ? pool.reverse() : pool;
}

export function createEventStreamReplayCursor(): EventStreamReplayCursor {
  return { laneIndex: 0, itemIndexes: {} };
}

export function isEventStreamHighlight(item: EventStreamItem): boolean {
  return replayLaneFor(item) !== "live";
}

export function nextEventStreamReplayItem(
  items: readonly EventStreamItem[],
  cursor: EventStreamReplayCursor,
): EventStreamItem | null {
  const byLane = new Map<string, EventStreamItem[]>();
  for (const item of items) {
    const lane = replayLaneFor(item);
    byLane.set(lane, [...(byLane.get(lane) ?? []), item]);
  }

  const lanes = REPLAY_LANE_ORDER
    .map((key) => ({ key, items: byLane.get(key) ?? [] }))
    .filter((lane) => lane.items.length > 0);
  if (lanes.length === 0) return null;

  const lane = lanes[cursor.laneIndex % lanes.length]!;
  cursor.laneIndex += 1;

  const itemIndex = cursor.itemIndexes[lane.key] ?? 0;
  cursor.itemIndexes[lane.key] = itemIndex + 1;
  return lane.items[itemIndex % lane.items.length]!;
}

export function createMixedEventStreamReplayItems(
  items: readonly EventStreamItem[],
  options: LoopingEventStreamPoolOptions = {},
  cursor: EventStreamReplayCursor = createEventStreamReplayCursor(),
): readonly EventStreamItem[] {
  const itemCount = Math.max(0, options.itemCount ?? items.length);
  const out: EventStreamItem[] = [];

  for (let i = 0; i < itemCount; i++) {
    const item = nextEventStreamReplayItem(items, cursor);
    if (!item) break;
    out.push(item);
  }

  return out;
}

export function createUniqueMixedEventStreamReplayItems(
  items: readonly EventStreamItem[],
  options: LoopingEventStreamPoolOptions = {},
  cursor: EventStreamReplayCursor = createEventStreamReplayCursor(),
): readonly EventStreamItem[] {
  const itemCount = Math.max(0, options.itemCount ?? items.length);
  if (itemCount === 0 || items.length === 0) return [];

  const availableIds = new Set(items.map((item) => item.id));
  const seenIds = new Set<string>();
  const out: EventStreamItem[] = [];
  const maxAttempts = items.length * Math.max(itemCount, availableIds.size, 1);

  for (
    let attempts = 0;
    attempts < maxAttempts && out.length < itemCount && seenIds.size < availableIds.size;
    attempts += 1
  ) {
    const item = nextEventStreamReplayItem(items, cursor);
    if (!item) break;
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    out.push(item);
  }

  return out;
}

export function createLoopingEventStreamPool(
  pool: readonly EventStreamItem[],
  options: LoopingEventStreamPoolOptions = {},
): readonly EventStreamItem[] {
  if (pool.length === 0) return [];

  const itemCount = Math.max(0, options.itemCount ?? pool.length);
  return Array.from(
    { length: itemCount },
    (_, index) => pool[index % pool.length]!,
  );
}
