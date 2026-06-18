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

import { useMemo, useSyncExternalStore } from "react";

export type EventStreamCategory =
  | "app"
  | "social"
  | "points"
  | "leaderboard"
  | "identity"
  | "admin"
  | "system";

export type EventStreamTone = "neutral" | "positive" | "negative" | "warning";

export interface EventStreamEntity {
  type: "domain" | "account" | "username" | "source" | string;
  id: string;
  label?: string;
}

export interface EventStreamItem<TPayload = unknown> {
  id: string;
  source: string;
  sourceLabel?: string;
  kind: string;
  category: EventStreamCategory;
  tone: EventStreamTone;
  title: string;
  detail?: string;
  entities: EventStreamEntity[];
  payload?: TPayload;
  /** Source event time if known; falls back to receive time for live chain events. */
  occurredAt: number;
  receivedAt: number;
}

export type EventStreamInput<TPayload = unknown> =
  Partial<Pick<EventStreamItem<TPayload>, "id" | "source" | "sourceLabel" | "tone" | "entities" | "occurredAt" | "receivedAt">>
  & Pick<EventStreamItem<TPayload>, "kind" | "category" | "title">
  & {
    detail?: string;
    payload?: TPayload;
  };

export type EventStreamUnsubscribe = () => void;

export interface EventStreamSourceContext {
  emit<TPayload = unknown>(item: EventStreamInput<TPayload>): void;
  error(error: unknown, detail?: string): void;
}

export interface EventStreamSource {
  id: string;
  label: string;
  connect(
    context: EventStreamSourceContext,
  ): void | EventStreamUnsubscribe | Promise<void | EventStreamUnsubscribe>;
}

export interface EventStreamStoreOptions {
  maxItems?: number;
}

interface SourceRuntime {
  active: boolean;
  stop?: EventStreamUnsubscribe;
}

export class EventStreamStore {
  private readonly maxItems: number;
  private readonly sources = new Map<string, EventStreamSource>();
  private readonly sourceRuntimes = new Map<string, SourceRuntime>();
  private readonly snapshotListeners = new Set<() => void>();
  private readonly itemListeners = new Set<(item: EventStreamItem) => void>();
  private items: readonly EventStreamItem[] = [];
  private nextId = 1;

  constructor(options: EventStreamStoreOptions = {}) {
    this.maxItems = options.maxItems ?? 200;
  }

  getSnapshot(): readonly EventStreamItem[] {
    return this.items;
  }

  getSources(): readonly EventStreamSource[] {
    return [...this.sources.values()];
  }

  registerSource(source: EventStreamSource): EventStreamUnsubscribe {
    if (this.sources.has(source.id)) {
      throw new Error(`event stream source already registered: ${source.id}`);
    }
    this.sources.set(source.id, source);
    if (this.hasSubscribers()) this.startSource(source);
    return () => {
      this.stopSource(source.id);
      this.sources.delete(source.id);
    };
  }

  add<TPayload = unknown>(input: EventStreamInput<TPayload>): EventStreamItem<TPayload> {
    const now = Date.now();
    const receivedAt = input.receivedAt ?? now;
    const source = input.source ?? "manual";
    const item: EventStreamItem<TPayload> = {
      id: input.id ?? `${source}:${receivedAt}:${this.nextId++}`,
      source,
      sourceLabel: input.sourceLabel,
      kind: input.kind,
      category: input.category,
      tone: input.tone ?? "neutral",
      title: input.title,
      detail: input.detail,
      entities: input.entities ?? [],
      payload: input.payload,
      occurredAt: input.occurredAt ?? receivedAt,
      receivedAt,
    };

    this.items = [item, ...this.items].slice(0, this.maxItems);
    this.notify(item);
    return item;
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.notifySnapshot();
  }

  dispose(): void {
    for (const sourceId of [...this.sourceRuntimes.keys()]) {
      this.stopSource(sourceId);
    }
    this.snapshotListeners.clear();
    this.itemListeners.clear();
  }

  subscribe(listener: () => void): EventStreamUnsubscribe {
    this.snapshotListeners.add(listener);
    this.ensureStarted();
    return () => {
      this.snapshotListeners.delete(listener);
      this.stopIfIdle();
    };
  }

  subscribeItems(listener: (item: EventStreamItem) => void): EventStreamUnsubscribe {
    this.itemListeners.add(listener);
    this.ensureStarted();
    return () => {
      this.itemListeners.delete(listener);
      this.stopIfIdle();
    };
  }

  private hasSubscribers(): boolean {
    return this.snapshotListeners.size > 0 || this.itemListeners.size > 0;
  }

  private ensureStarted(): void {
    for (const source of this.sources.values()) {
      this.startSource(source);
    }
  }

  private startSource(source: EventStreamSource): void {
    if (this.sourceRuntimes.has(source.id)) return;

    const runtime: SourceRuntime = { active: true };
    this.sourceRuntimes.set(source.id, runtime);

    const context: EventStreamSourceContext = {
      emit: (input) => {
        if (!runtime.active) return;
        this.add({
          ...input,
          source: input.source ?? source.id,
          sourceLabel: input.sourceLabel ?? source.label,
        });
      },
      error: (error, detail) => {
        if (!runtime.active) return;
        const message = error instanceof Error ? error.message : String(error);
        this.add({
          source: source.id,
          sourceLabel: source.label,
          kind: "stream.source-error",
          category: "system",
          tone: "warning",
          title: `${source.label} stream error`,
          detail: detail ? `${detail}: ${message}` : message,
          entities: [{ type: "source", id: source.id, label: source.label }],
          payload: { error: message },
        });
      },
    };

    Promise.resolve()
      .then(() => source.connect(context))
      .then((stop) => {
        if (!runtime.active) {
          stop?.();
          return;
        }
        runtime.stop = stop ?? undefined;
      })
      .catch((error) => context.error(error, "connect failed"));
  }

  private stopSource(sourceId: string): void {
    const runtime = this.sourceRuntimes.get(sourceId);
    if (!runtime) return;
    runtime.active = false;
    this.sourceRuntimes.delete(sourceId);
    runtime.stop?.();
  }

  private stopIfIdle(): void {
    if (this.hasSubscribers()) return;
    for (const sourceId of [...this.sourceRuntimes.keys()]) {
      this.stopSource(sourceId);
    }
  }

  private notify(item: EventStreamItem): void {
    for (const listener of [...this.itemListeners]) {
      try {
        listener(item);
      } catch (err) {
        console.error("[playground] event stream item listener failed", err);
      }
    }
    this.notifySnapshot();
  }

  private notifySnapshot(): void {
    for (const listener of [...this.snapshotListeners]) {
      listener();
    }
  }
}

export interface UseEventStreamOptions {
  limit?: number;
  sources?: readonly string[];
  categories?: readonly EventStreamCategory[];
  kinds?: readonly string[];
}

export function filterEventStreamItems(
  items: readonly EventStreamItem[],
  options: UseEventStreamOptions = {},
): readonly EventStreamItem[] {
  const sourceSet = options.sources ? new Set(options.sources) : null;
  const categorySet = options.categories ? new Set(options.categories) : null;
  const kindSet = options.kinds ? new Set(options.kinds) : null;
  const limit = options.limit ?? items.length;
  const out: EventStreamItem[] = [];

  for (const item of items) {
    if (sourceSet && !sourceSet.has(item.source)) continue;
    if (categorySet && !categorySet.has(item.category)) continue;
    if (kindSet && !kindSet.has(item.kind)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }

  return out;
}

export function useEventStream(
  store: EventStreamStore,
  options: UseEventStreamOptions = {},
): readonly EventStreamItem[] {
  const items = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  return useMemo(
    () => filterEventStreamItems(items, options),
    [items, options],
  );
}
