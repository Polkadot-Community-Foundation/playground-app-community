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

import { describe, expect, it, vi } from "vitest";
import {
  EventStreamStore,
  filterEventStreamItems,
  type EventStreamItem,
  type EventStreamSourceContext,
} from "./eventStream";
import {
  createEventStreamPool,
  createEventStreamReplayCursor,
  createLoopingEventStreamPool,
  createMixedEventStreamReplayItems,
  createUniqueMixedEventStreamReplayItems,
} from "./eventPool";

describe("EventStreamStore", () => {
  it("starts sources lazily, stores emitted items, and stops when idle", async () => {
    const store = new EventStreamStore();
    const stop = vi.fn();
    const connect = vi.fn((context: EventStreamSourceContext) => {
      context.emit({
        kind: "test.started",
        category: "system",
        title: "Started",
      });
      return stop;
    });

    store.registerSource({ id: "test", label: "Test source", connect });
    expect(connect).not.toHaveBeenCalled();

    const onSnapshot = vi.fn();
    const unsubscribe = store.subscribe(onSnapshot);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      source: "test",
      sourceLabel: "Test source",
      kind: "test.started",
      title: "Started",
    });
    expect(onSnapshot).toHaveBeenCalled();

    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("notifies item listeners for new items without replaying old items", () => {
    const store = new EventStreamStore();
    store.add({
      kind: "manual.old",
      category: "system",
      title: "Old",
    });

    const onItem = vi.fn();
    const unsubscribe = store.subscribeItems(onItem);
    expect(onItem).not.toHaveBeenCalled();

    store.add({
      kind: "manual.new",
      category: "app",
      title: "New",
    });

    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onItem.mock.calls[0][0]).toMatchObject({ kind: "manual.new" });

    unsubscribe();
    store.add({
      kind: "manual.after",
      category: "app",
      title: "After",
    });
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest items up to maxItems", () => {
    const store = new EventStreamStore({ maxItems: 2 });
    store.add({ kind: "a", category: "app", title: "A" });
    store.add({ kind: "b", category: "app", title: "B" });
    store.add({ kind: "c", category: "app", title: "C" });

    expect(store.getSnapshot().map((item) => item.kind)).toEqual(["c", "b"]);
  });

  it("disposes active sources and listeners", async () => {
    const store = new EventStreamStore();
    const stop = vi.fn();
    const connect = vi.fn(() => stop);
    const onSnapshot = vi.fn();

    store.registerSource({ id: "test", label: "Test source", connect });
    store.subscribe(onSnapshot);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    store.dispose();
    expect(stop).toHaveBeenCalledTimes(1);

    store.add({ kind: "manual.after", category: "system", title: "After" });
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

describe("filterEventStreamItems", () => {
  it("filters by source, category, kind, and limit", () => {
    const store = new EventStreamStore();
    store.add({ source: "registry", kind: "registry.Published", category: "app", title: "A" });
    store.add({ source: "registry", kind: "registry.Pinned", category: "admin", title: "B" });
    store.add({ source: "stats", kind: "leaderboard.first", category: "leaderboard", title: "C" });

    expect(
      filterEventStreamItems(store.getSnapshot(), {
        sources: ["registry"],
        categories: ["app", "admin"],
        kinds: ["registry.Published", "registry.Pinned"],
        limit: 1,
      }).map((item) => item.title),
    ).toEqual(["B"]);
  });
});

function testItem(id: string): EventStreamItem {
  return {
    id,
    source: "test",
    kind: `test.${id}`,
    category: "app",
    tone: "neutral",
    title: id,
    entities: [],
    occurredAt: 0,
    receivedAt: 0,
  };
}

describe("event stream pools", () => {
  it("keeps a bounded newest-first pool of displayable items", () => {
    const pool = createEventStreamPool(
      [
        testItem("c"),
        { ...testItem("error"), kind: "stream.source-error" },
        testItem("b"),
        testItem("c"),
        testItem("a"),
      ],
      { excludeKinds: ["stream.source-error"], limit: 2 },
    );

    expect(pool.map((item) => item.id)).toEqual(["c", "b"]);
  });

  it("repeats light pools without changing item order", () => {
    const row = createLoopingEventStreamPool(
      [testItem("a"), testItem("b")],
      { itemCount: 5 },
    );

    expect(row.map((item) => item.id)).toEqual(["a", "b", "a", "b", "a"]);
  });

  it("can order the pool for ticker-style append-at-tail rendering", () => {
    const pool = createEventStreamPool(
      [testItem("c"), testItem("b"), testItem("a")],
      { order: "oldest-first" },
    );

    expect(pool.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("mixes live events with highlight lanes while rotating recent publishes", () => {
    const cursor = createEventStreamReplayCursor();
    const row = createMixedEventStreamReplayItems(
      [
        testItem("live-a"),
        {
          ...testItem("leader"),
          source: "registry-highlights",
          kind: "registry-highlight.current-leader",
        },
        {
          ...testItem("publish-a"),
          source: "registry-highlights",
          kind: "registry-highlight.recent-publish",
        },
        {
          ...testItem("publish-b"),
          source: "registry-highlights",
          kind: "registry-highlight.recent-publish",
        },
        {
          ...testItem("count"),
          source: "registry-highlights",
          kind: "registry-highlight.app-count",
        },
        testItem("live-b"),
      ],
      { itemCount: 9 },
      cursor,
    );

    expect(row.map((item) => item.id)).toEqual([
      "live-a",
      "leader",
      "publish-a",
      "live-b",
      "count",
      "publish-b",
      "live-a",
      "leader",
      "publish-a",
    ]);
  });

  it("seeds initial ticker items without repeating a sparse pool", () => {
    const row = createUniqueMixedEventStreamReplayItems(
      [{
        ...testItem("countdown"),
        source: "leaderboard-countdown",
        kind: "registry-highlight.leaderboard-countdown",
      }],
      { itemCount: 12 },
    );

    expect(row.map((item) => item.id)).toEqual(["countdown"]);
  });

  it("skips lane repeats while seeding unique initial ticker items", () => {
    const cursor = createEventStreamReplayCursor();
    const row = createUniqueMixedEventStreamReplayItems(
      [
        testItem("live"),
        {
          ...testItem("leader"),
          source: "registry-highlights",
          kind: "registry-highlight.current-leader",
        },
        {
          ...testItem("publish-a"),
          source: "registry-highlights",
          kind: "registry-highlight.recent-publish",
        },
        {
          ...testItem("publish-b"),
          source: "registry-highlights",
          kind: "registry-highlight.recent-publish",
        },
        {
          ...testItem("publish-c"),
          source: "registry-highlights",
          kind: "registry-highlight.recent-publish",
        },
      ],
      { itemCount: 5 },
      cursor,
    );

    expect(row.map((item) => item.id)).toEqual([
      "live",
      "leader",
      "publish-a",
      "publish-b",
      "publish-c",
    ]);
  });
});
