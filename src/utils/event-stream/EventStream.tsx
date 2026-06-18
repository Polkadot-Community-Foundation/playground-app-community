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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import {
  Star,
  GitMerge,
  Rocket,
  TrendingUp,
  Sparkles,
  UserPlus,
  Pin,
  Activity,
  AlertTriangle,
  Timer,
} from "lucide-react";
import { LEADERBOARD_COUNTDOWN_KIND, type LeaderboardCountdownPayload } from "./leaderboardCountdownEventStreamSource";
import { handleExternalClick } from "../externalNavigation";
import { profilePathForAccount } from "../username";
import { type EventStreamItem } from "./eventStream";
import {
  createEventStreamPool,
  createEventStreamReplayCursor,
  createUniqueMixedEventStreamReplayItems,
  isEventStreamHighlight,
  nextEventStreamReplayItem,
  type EventStreamReplayCursor,
} from "./eventPool";
import { usePlaygroundEventStream } from "./playgroundEventStream";

const STREAM_POOL_LIMIT = 80;
const TICKER_POOL_LIMIT = 24;
const TICKER_QUEUE_LIMIT = 80;
const TICKER_INITIAL_ITEM_COUNT = 12;
const TICKER_SPEED_PX_PER_SECOND = 44;
const TICKER_EXCLUDED_KINDS = [
  "stream.source-error",
  "registry.Pinned",
  "registry.Unpinned",
  "registry.Unpublished",
  "registry.VisibilityChanged",
  "registry.RatingRemoved",
  "registry.StarPointRefunded",
  "registry.IdentityCleared",
  "registry.AnonymousBonusAwarded",
  "registry.FaucetFailed",
] as const;
const STREAM_OPTIONS = { limit: STREAM_POOL_LIMIT } as const;

interface TickerSlot {
  slotId: string;
  item: EventStreamItem;
}

function iconFor(item: EventStreamItem): ReactNode {
  const k = item.kind;
  if (k === LEADERBOARD_COUNTDOWN_KIND) return <Timer size={12} aria-hidden="true" />;
  if (item.tone === "warning" || item.tone === "negative") return <AlertTriangle size={12} aria-hidden="true" />;
  if (k.includes("Pinned") || k.includes("pinned")) return <Pin size={12} aria-hidden="true" />;
  if (k.includes("Star") || k.includes("star")) return <Star size={12} aria-hidden="true" />;
  if (k.includes("Mod") || k.includes("mod")) return <GitMerge size={12} aria-hidden="true" />;
  if (k.includes("Publish") || k.includes("publish")) return <Rocket size={12} aria-hidden="true" />;
  if (k.includes("rank") || item.category === "leaderboard") return <TrendingUp size={12} aria-hidden="true" />;
  if (k.includes("milestone")) return <Sparkles size={12} aria-hidden="true" />;
  if (k.includes("Username") || k.includes("username") || item.category === "identity") return <UserPlus size={12} aria-hidden="true" />;
  if (k.includes("Moddable") || k.includes("moddable")) return <Sparkles size={12} aria-hidden="true" />;
  return <Activity size={12} aria-hidden="true" />;
}

function entityHrefFor(item: EventStreamItem): string | undefined {
  const domain = item.entities.find((e) => e.type === "domain");
  if (domain) return appWebsiteHref(domain.id);
  if (item.category === "leaderboard") return "/leaderboard";
  if (item.category === "identity") return "/profile";
  return undefined;
}

function appWebsiteHref(domain: string): string {
  return `https://${domain.endsWith(".dot") ? domain : `${domain}.dot`}`;
}

interface TitleLink {
  start: number;
  end: number;
  label: string;
  href: string;
  external: boolean;
}

function titleLinksFor(item: EventStreamItem): readonly TitleLink[] {
  const links: TitleLink[] = [];

  for (const entity of item.entities) {
    const label = entity.label;
    if (!label) continue;
    const start = item.title.indexOf(label);
    if (start < 0) continue;

    if (entity.type === "account") {
      links.push({
        start,
        end: start + label.length,
        label,
        href: profilePathForAccount(entity.id),
        external: false,
      });
    } else if (entity.type === "domain") {
      links.push({
        start,
        end: start + label.length,
        label,
        href: appWebsiteHref(entity.id),
        external: true,
      });
    } else if (entity.type === "route") {
      links.push({
        start,
        end: start + label.length,
        label,
        href: entity.id,
        external: false,
      });
    }
  }

  return links
    .sort((a, b) => a.start - b.start)
    .filter((link, index, sorted) => index === 0 || link.start >= sorted[index - 1]!.end);
}

export default function EventStream() {
  const items = usePlaygroundEventStream(STREAM_OPTIONS);
  const pool = useMemo(
    () => createEventStreamPool(items, {
      excludeKinds: TICKER_EXCLUDED_KINDS,
      limit: TICKER_POOL_LIMIT,
      order: "oldest-first",
    }),
    [items],
  );
  const { slots, advance } = useTickerSlots(pool);
  const { windowRef, trackRef, rowRef, setPaused } = useTickerMarquee(slots, advance);

  return (
    <div
      className="event-ticker"
      aria-label="Live playground activity"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="event-ticker-lede">
        <span className="event-ticker-pulse" />
        Live
      </div>
      <div className="event-ticker-window" ref={windowRef}>
        <div className="event-ticker-track" ref={trackRef}>
          <TickerRow slots={slots} rowRef={rowRef} />
        </div>
      </div>
      <div className="event-ticker-fade" />
    </div>
  );
}

function useTickerSlots(pool: readonly EventStreamItem[]) {
  const knownIdsRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<EventStreamItem[]>([]);
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const replayCursorRef = useRef<EventStreamReplayCursor>(createEventStreamReplayCursor());
  const poolRef = useRef<readonly EventStreamItem[]>([]);
  const slotsRef = useRef<readonly TickerSlot[]>([]);
  const slotCounterRef = useRef(0);
  const [slots, setSlots] = useState<readonly TickerSlot[]>([]);

  const createSlot = useCallback((item: EventStreamItem): TickerSlot => {
    slotCounterRef.current += 1;
    return { slotId: `${item.id}:${slotCounterRef.current}`, item };
  }, []);

  useEffect(() => {
    poolRef.current = pool;
    if (pool.length === 0) return;

    if (slotsRef.current.length === 0) {
      for (const item of pool) knownIdsRef.current.add(item.id);
      const cursor = createEventStreamReplayCursor();
      const initialSlots = createUniqueMixedEventStreamReplayItems(
        pool,
        { itemCount: TICKER_INITIAL_ITEM_COUNT },
        cursor,
      ).map(createSlot);
      replayCursorRef.current = cursor;
      slotsRef.current = initialSlots;
      setSlots(initialSlots);
      return;
    }

    const fresh = pool.filter((item) => !knownIdsRef.current.has(item.id));
    if (fresh.length === 0) return;

    for (const item of fresh) knownIdsRef.current.add(item.id);
    const topUpItems = slotsRef.current.length < TICKER_INITIAL_ITEM_COUNT
      ? fresh.slice(0, TICKER_INITIAL_ITEM_COUNT - slotsRef.current.length)
      : [];
    if (topUpItems.length > 0) {
      const nextSlots = [...slotsRef.current, ...topUpItems.map(createSlot)];
      slotsRef.current = nextSlots;
      setSlots(nextSlots);
    }

    const topUpIds = new Set(topUpItems.map((item) => item.id));
    const freshLive = fresh.filter((item) => !topUpIds.has(item.id) && !isEventStreamHighlight(item));
    pendingRef.current.push(...freshLive);
    for (const item of freshLive) pendingIdsRef.current.add(item.id);
    if (pendingRef.current.length > TICKER_QUEUE_LIMIT) {
      const dropped = pendingRef.current.splice(0, pendingRef.current.length - TICKER_QUEUE_LIMIT);
      for (const item of dropped) pendingIdsRef.current.delete(item.id);
    }
  }, [createSlot, pool]);

  const nextItem = useCallback((includePending: boolean): EventStreamItem | null => {
    if (includePending) {
      const pending = pendingRef.current.shift();
      if (pending) {
        pendingIdsRef.current.delete(pending.id);
        return pending;
      }
    }

    const replayPool = poolRef.current;
    for (let i = 0; i < Math.max(replayPool.length, 1); i++) {
      const replayItem = nextEventStreamReplayItem(replayPool, replayCursorRef.current);
      if (!replayItem) break;
      if (includePending || !pendingIdsRef.current.has(replayItem.id)) return replayItem;
    }

    return slotsRef.current[0]?.item ?? null;
  }, []);

  const advance = useCallback((): boolean => {
    const item = nextItem(true);
    if (!item) return false;

    const current = slotsRef.current;
    const nextSlots = current.length === 0
      ? [createSlot(item)]
      : [...current.slice(1), createSlot(item)];
    slotsRef.current = nextSlots;
    setSlots(nextSlots);
    return true;
  }, [createSlot, nextItem]);

  return { slots, advance };
}

function useTickerMarquee(
  slots: readonly TickerSlot[],
  advance: () => boolean,
) {
  const windowRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const offsetRef = useRef(0);
  const advanceByRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const advanceRef = useRef(advance);
  const startedOffscreenRef = useRef(false);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  useLayoutEffect(() => {
    advanceByRef.current = measureFirstItemAdvance(rowRef.current);
    if (startedOffscreenRef.current || slots.length === 0 || prefersReducedTickerMotion()) return;

    const startOffset = windowRef.current?.getBoundingClientRect().width ?? 0;
    if (startOffset <= 0) return;

    startedOffscreenRef.current = true;
    offsetRef.current = -startOffset;
    if (trackRef.current) {
      trackRef.current.style.transform = `translate3d(${startOffset}px, 0, 0)`;
    }
  }, [slots]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      advanceByRef.current = measureFirstItemAdvance(row);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (prefersReducedTickerMotion()) return;

    let frameId = 0;
    const tick = (time: number) => {
      const lastFrame = lastFrameRef.current ?? time;
      lastFrameRef.current = time;

      if (!pausedRef.current) {
        const elapsedMs = Math.min(time - lastFrame, 100);
        offsetRef.current += (elapsedMs / 1_000) * TICKER_SPEED_PX_PER_SECOND;

        const advanceBy = advanceByRef.current;
        if (advanceBy > 0) {
          while (offsetRef.current >= advanceBy) {
            offsetRef.current -= advanceBy;
            let advanced = false;
            flushSync(() => {
              advanced = advanceRef.current();
            });
            if (!advanced) break;
          }
        }

        if (trackRef.current) {
          trackRef.current.style.transform = `translate3d(${-offsetRef.current}px, 0, 0)`;
        }
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const setPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
  }, []);

  return { windowRef, trackRef, rowRef, setPaused };
}

function prefersReducedTickerMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function measureFirstItemAdvance(row: HTMLDivElement | null): number {
  if (!row) return 0;

  const first = row.querySelector<HTMLElement>(".event-ticker-item");
  const second = first?.nextElementSibling as HTMLElement | null;
  if (!first) return 0;

  if (second) {
    return second.getBoundingClientRect().left - first.getBoundingClientRect().left;
  }

  const gap = Number.parseFloat(window.getComputedStyle(row).columnGap) || 0;
  return first.getBoundingClientRect().width + gap;
}

interface TickerRowProps {
  slots: readonly TickerSlot[];
  rowRef: RefObject<HTMLDivElement | null>;
}

function TickerRow({ slots, rowRef }: TickerRowProps) {
  const linkedIds = new Set<string>();

  return (
    <div className="event-ticker-row" ref={rowRef}>
      {slots.map((slot) => {
        const shouldLink = !linkedIds.has(slot.item.id);
        linkedIds.add(slot.item.id);
        return (
          <TickerItem
            key={slot.slotId}
            item={slot.item}
            interactive={shouldLink}
          />
        );
      })}
    </div>
  );
}

interface TickerItemProps {
  item: EventStreamItem;
  interactive: boolean;
}

// Beyond this many hours out, show the static close-time memo (item.title)
// rather than a coarse "in N days" countdown.
const COUNTDOWN_LIVE_WINDOW_MS = 20 * 3_600_000;

// `live` is true only while the active "in N …" countdown is showing — the
// static close-time memo and the post-deadline message render in the default
// (white) colour; the live countdown is tinted red (see App.css).
function countdownTitleFor(item: EventStreamItem): { title: string; live: boolean } {
  const deadline = (item.payload as LeaderboardCountdownPayload | undefined)?.deadline;
  if (typeof deadline !== "number" || Number.isNaN(deadline)) return { title: item.title, live: false };

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return { title: "Winners have been decided!", live: false };
  if (remainingMs > COUNTDOWN_LIVE_WINDOW_MS) return { title: item.title, live: false };

  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return { title: `Winners decided in ${minutes} minute${minutes === 1 ? "" : "s"}!`, live: true };
  }
  const hours = Math.round(remainingMs / 3_600_000);
  return { title: `Winners decided in ${hours} hour${hours === 1 ? "" : "s"}!`, live: true };
}

function TickerItem({ item, interactive }: TickerItemProps) {
  const titleLinks = interactive ? titleLinksFor(item) : [];
  const href = interactive && titleLinks.length === 0 ? entityHrefFor(item) : undefined;
  const countdown = item.kind === LEADERBOARD_COUNTDOWN_KIND ? countdownTitleFor(item) : null;
  const urgent = countdown?.live ?? false;
  const className = `event-ticker-item${href ? " event-ticker-item-link" : ""}${urgent ? " event-ticker-item--urgent" : ""}`;
  const title = countdown ? countdown.title : item.title;
  const titleClassName = `event-ticker-title${countdown?.live ? " event-ticker-title-countdown" : ""}`;

  const content = (
    <>
      <span className="event-ticker-icon">{iconFor(item)}</span>
      <span className={titleClassName}>
        {titleLinks.length > 0 ? renderLinkedTitle(item.title, titleLinks) : title}
      </span>
    </>
  );

  if (href) {
    if (href.startsWith("http")) {
      return (
        <a
          href={href}
          className={className}
          data-tone={item.tone}
          data-category={item.category}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleExternalClick}
        >
          {content}
        </a>
      );
    }
    return (
      <Link
        to={href}
        className={className}
        data-tone={item.tone}
        data-category={item.category}
      >
        {content}
      </Link>
    );
  }
  return (
    <span
      className={className}
      data-tone={item.tone}
      data-category={item.category}
    >
      {content}
    </span>
  );
}

function renderLinkedTitle(title: string, links: readonly TitleLink[]): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;

  links.forEach((link, index) => {
    if (link.start > cursor) parts.push(title.slice(cursor, link.start));
    const key = `${link.href}:${index}`;
    parts.push(link.external ? (
      <a
        key={key}
        href={link.href}
        className="event-ticker-title-link"
        title={link.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleExternalClick}
      >
        {link.label}
      </a>
    ) : (
      <Link
        key={key}
        to={link.href}
        className="event-ticker-title-link"
        title={link.label}
      >
        {link.label}
      </Link>
    ));
    cursor = link.end;
  });

  if (cursor < title.length) parts.push(title.slice(cursor));
  return parts;
}
