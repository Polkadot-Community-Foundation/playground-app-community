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

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { Maximize2, Minimize2, LocateFixed } from "lucide-react";
import BackToTop from "./BackToTop";
import BecomeBuilderCard from "./BecomeBuilderCard";
import { useOnboarding } from "./OnboardingProvider";
import {
  registryReady,
  stringify,
  shortAddr,
  displayNameForAccount,
  profilePathForAccount,
  useIntersectionObserver,
  useKioskAutoScroll,
} from "./utils";
import { useRootUsernamesBatch, useRootUsername } from "./utils/identity";
import { withReadDeadline } from "./utils/deadline.ts";
import { readLeaderboardSnapshot, writeLeaderboardSnapshot } from "./utils/snapshotCache";
import { fetchAppDataBatch } from "./registryAppData.ts";

interface TopBuilderRow { account: string; score: bigint }

const PAGE_SIZE = 20;

// Fullscreen "kiosk" tuning — the unattended big-screen venue view. Nobody
// scrolls a wall display, so we load the board up front and auto-scroll it (the
// slow-scroll loop itself lives in useKioskAutoScroll). Sized to the venue's
// 1000-person max so a normal board never truncates — eager-loading stops once
// hasMore goes false. ~3k DOM nodes at the cap; native scroll handles it.
const MAX_KIOSK_ROWS = 1000;
// Side widgets (top-starred / top-modded apps) each show the top 30.
const MAX_WIDGET_ROWS = 30;

export interface TopBuilder {
  account: string;
  score: bigint;
}

export { shortAddr };

// Returns null on failure (vs [] for a genuinely empty page) so callers can
// keep showing cached rows instead of treating a flaky read as an empty board.
async function fetchTopBuilders(start: number, count: number): Promise<TopBuilder[] | null> {
  try {
    const registry = await registryReady;
    const res = await withReadDeadline(registry.getTopBuilders.query(start, count), "Registry top builders");
    if (!res.success) {
      console.warn(
        `[playground] registry.getTopBuilders(${start}, ${count}) returned success:false — ${stringify(res)}`,
      );
      return null;
    }
    return res.value.map((e: TopBuilderRow) => ({ account: e.account, score: e.score }));
  } catch (cause) {
    console.warn(
      `[playground] registry.getTopBuilders(${start}, ${count}) threw — ${stringify(cause)}`,
    );
    return null;
  }
}

// ── Side widgets: top-starred / top-modded APPS ─────────────────────────────
// Distinct from the main board (which ranks users by XP): these rank apps by
// stars / mods received, via the on-chain sorted indexes behind getTopStarred /
// getTopModded. Fullscreen-only.

type SocialKind = "stars" | "mods";
interface TopApp { domain: string; count: number }

// One sorted page of apps. AppEntry rows carry the domain but NOT the count, so
// the count is resolved separately (fetchAppCount). The contract filters out
// unpublished/private domains, so callers must advance pagination by `scanned`
// (index entries consumed), not by the number of rows returned. Null on failure.
async function fetchTopApps(
  kind: SocialKind,
  start: number,
  count: number,
): Promise<{ domains: string[]; scanned: number } | null> {
  const method = kind === "stars" ? "getTopStarred" : "getTopModded";
  try {
    const registry = await registryReady;
    const res = await withReadDeadline<any>((registry as any)[method].query(start, count), `Registry ${method}`);
    if (!res.success) {
      console.warn(`[playground] registry.${method}(${start}, ${count}) returned success:false — ${stringify(res)}`);
      return null;
    }
    return {
      domains: res.value.entries.map((e: { domain: string }) => e.domain),
      scanned: Number(res.value.scanned),
    };
  } catch (cause) {
    console.warn(`[playground] registry.${method}(${start}, ${count}) threw — ${stringify(cause)}`);
    return null;
  }
}

// Counts for a sorted app page. Treats failure as 0 — a missing count shouldn't
// blank the whole row in an unattended display.
async function fetchAppCounts(kind: SocialKind, domains: string[]): Promise<Map<string, number>> {
  const appData = await fetchAppDataBatch(domains);
  const out = new Map<string, number>();
  for (const domain of domains) {
    const data = appData?.get(domain);
    out.set(domain, kind === "stars" ? data?.starCount ?? 0 : data?.modCount ?? 0);
  }
  return out;
}

// Load a capped, ranked list of apps for a widget, then resolve each one's
// count. Reloads on `refreshKey` so award events keep the widgets live, in step
// with the main board. Only runs while `enabled` (fullscreen).
function useTopApps(kind: SocialKind, enabled: boolean, refreshKey: number): TopApp[] {
  const [apps, setApps] = useState<TopApp[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const domains: string[] = [];
      let start = 0;
      while (domains.length < MAX_WIDGET_ROWS) {
        const page = await fetchTopApps(kind, start, PAGE_SIZE);
        if (cancelled) return;
        if (!page) break;
        domains.push(...page.domains);
        start += page.scanned;
        if (page.scanned < PAGE_SIZE) break; // sorted index exhausted
      }
      const capped = domains.slice(0, MAX_WIDGET_ROWS);
      const counts = await fetchAppCounts(kind, capped);
      if (cancelled) return;
      setApps(capped.map((domain) => ({ domain, count: counts.get(domain) ?? 0 })));
    })();
    return () => { cancelled = true; };
  }, [kind, enabled, refreshKey]);
  return apps;
}

// A pinned panel listing top apps for one metric; its list scrolls on its own
// (the same slow loop as the main board) while the panel header stays put.
function SideWidget({ kind, title, enabled, autoScroll, refreshKey }: {
  kind: SocialKind;
  title: string;
  enabled: boolean;
  autoScroll: boolean; // side layout → list auto-scrolls; bottom layout → shown inline
  refreshKey: number;
}) {
  const apps = useTopApps(kind, enabled, refreshKey);
  const listRef = useRef<HTMLOListElement | null>(null);
  useKioskAutoScroll(listRef, autoScroll && enabled && apps.length > 0, apps.length);

  return (
    <section className="leaderboard-widget" data-accent={kind} aria-label={title}>
      <header className="leaderboard-widget-head">{title}</header>
      {apps.length === 0 ? (
        <p className="leaderboard-widget-empty"><em>No apps yet.</em></p>
      ) : (
        <ol ref={listRef} className="leaderboard-widget-list">
          {apps.map((a, i) => (
            <li key={a.domain} className="leaderboard-widget-row" data-rank-hue={i % 5}>
              <span className="leaderboard-widget-rank">{i + 1}</span>
              <span className="leaderboard-widget-name" title={a.domain}>{a.domain}</span>
              <span className="leaderboard-widget-count">{a.count}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

interface LeaderboardProps {
  /** H160 of the current viewer — their row gets a "you" highlight. */
  currentUserAddr?: string | null;
  /**
   * Setter that exposes a refresh function to the parent. Wired into the
   * registry event dispatcher so award events trigger a re-fetch. The
   * parent receives `undefined` on unmount so it stops invoking a stale
   * setter bound to a tree that's no longer mounted.
   */
  registerRefresh?: (refresh: (() => void) | undefined) => void;
}

export default function Leaderboard({ currentUserAddr, registerRefresh }: LeaderboardProps) {
  // Snapshot-first paint: seed page 0 (rows + names) from the last persisted
  // board so a remount shows real ranks immediately instead of a skeleton.
  // Read once at mount — it's an initial-paint fallback only; live state
  // always wins once fetched.
  // Same onboarding gate as the Apps banner: prompt the connected user to get
  // resources until they have them; hidden once granted.
  const { account: onboardingAccount, hasResources } = useOnboarding();
  const showBecomeBuilder = !!onboardingAccount && !hasResources;
  const [snapshot] = useState(() => readLeaderboardSnapshot());
  const [entries, setEntries] = useState<TopBuilder[]>(snapshot?.entries ?? []);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  // Number of ranks fetched so far — the offset for the next page. A ref so
  // `loadMore` can stay a stable callback (the IntersectionObserver re-attaches
  // only when its enabled flag flips, not on every appended row).
  const loadedRef = useRef(0);
  // Guards against the observer firing `loadMore` again while one is in flight.
  const busyRef = useRef(false);
  // Bumped on every (re)load so an in-flight `loadMore` that started before an
  // event-driven refresh can detect it was superseded and drop its result
  // instead of appending a stale page to the freshly-reset list.
  const genRef = useRef(0);
  // Points at the connected user's own row so the footer "Find me" button can
  // scroll it into view.
  const meRowRef = useRef<HTMLLIElement | null>(null);
  // The row list — in the "side" layout this is the lone scroll container the
  // kiosk auto-scroll drives (wordmark + column header stay pinned above it).
  const listRef = useRef<HTMLOListElement | null>(null);
  // The board+widgets wrapper — in the "bottom" layout THIS is the scroller, so
  // the widgets reveal as a footer when the board reaches the end.
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Whether `entries` reflects a successful live fetch (vs the seeded
  // snapshot). Gates snapshot writes so a failed revalidation never
  // re-persists (and re-timestamps) the blob it painted from.
  const revalidatedRef = useRef(false);

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Toggle the body class that hides the rails + event ticker. Always strip the
  // class on unmount so leaving the route restores the normal three-column shell.
  useEffect(() => {
    document.body.classList.toggle("is-leader-fullscreen", fullscreen);
    return () => document.body.classList.remove("is-leader-fullscreen");
  }, [fullscreen]);

  useEffect(() => {
    if (!registerRefresh) return;
    registerRefresh(triggerRefresh);
    return () => registerRefresh(undefined);
  }, [registerRefresh, triggerRefresh]);

  // Initial load + full reset on every event-driven refresh: scores and ranks
  // shift when awards land, so we re-fetch from page zero rather than patch.
  useEffect(() => {
    let cancelled = false;
    // Bumped so an in-flight `loadMore` started before this refresh sees it was
    // superseded. The effect's own `.then` only needs `cancelled`, which fires
    // on both re-run and unmount (nothing else mutates `genRef`).
    genRef.current += 1;
    loadedRef.current = 0;
    revalidatedRef.current = false;
    setLoading(true);
    setHasMore(true);
    fetchTopBuilders(0, PAGE_SIZE).then((rows) => {
      if (cancelled) return;
      if (rows === null) {
        // Failed revalidation: keep whatever is on screen (snapshot rows or
        // the previous list) and disarm paging — offsets would be guesses.
        setHasMore(false);
      } else {
        setEntries(rows);
        loadedRef.current = rows.length;
        setHasMore(rows.length === PAGE_SIZE);
        revalidatedRef.current = true;
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const loadMore = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const gen = genRef.current;
    setLoadingMore(true);
    try {
      const start = loadedRef.current;
      const rows = await fetchTopBuilders(start, PAGE_SIZE);
      // A refresh replaced the list while we were fetching — discard this page.
      if (gen !== genRef.current) return;
      if (rows === null || rows.length === 0) {
        setHasMore(false);
        return;
      }
      loadedRef.current = start + rows.length;
      // Dedupe defensively: a rank shift between page reads could surface an
      // account we already show. Offset paging still advances by the raw page
      // size so we don't skip ranks.
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.account.toLowerCase()));
        const fresh = rows.filter((r) => !seen.has(r.account.toLowerCase()));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      setHasMore(rows.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
      busyRef.current = false;
    }
  }, []);

  const sentinelRef = useIntersectionObserver(loadMore, hasMore && !loading && !loadingMore);

  // Fullscreen venue mode has no scroller to trip the IntersectionObserver
  // sentinel, so walk the pages ourselves until the board is complete (or we
  // hit the kiosk cap). Each appended page re-runs this effect, chaining the
  // next load. Windowed mode keeps its lazy scroll-to-load behaviour untouched.
  useEffect(() => {
    if (!fullscreen || loading || loadingMore || !hasMore) return;
    if (entries.length >= MAX_KIOSK_ROWS) return;
    loadMore();
  }, [fullscreen, loading, loadingMore, hasMore, entries.length, loadMore]);

  // Slow auto-scroll for the unattended venue view. The board's own row list is
  // the scroll container, so the wordmark + column header stay pinned above it.
  // Enabled once the board (or the cap) is loaded so scrollHeight is stable.
  // Where the app widgets sit in fullscreen: "side" (default) pins them in a
  // right column beside the board; "bottom" puts them in the board's scroller so
  // they're revealed as a footer at the end. Toggle with ?widgets=bottom. Read
  // reactively (not at module scope) so client-side nav to the param takes effect.
  const widgetLayout =
    new URLSearchParams(useLocation().search).get("widgets") === "bottom" ? "bottom" : "side";

  const boardLoaded = !loading && (!hasMore || entries.length >= MAX_KIOSK_ROWS);
  // "side": the row list itself scrolls. "bottom": the whole board+widgets stage
  // scrolls (so the widgets reveal as a footer). Only one is enabled at a time.
  useKioskAutoScroll(listRef, fullscreen && boardLoaded && widgetLayout === "side", entries.length);
  useKioskAutoScroll(stageRef, fullscreen && boardLoaded && widgetLayout === "bottom", entries.length);

  const me = currentUserAddr?.toLowerCase();
  // Whether the connected user has a row in the currently-loaded list. The
  // footer band only shows once the full board is loaded, so by then this is
  // accurate for any ranked user.
  const meOnBoard = !!me && entries.some((e) => e.account.toLowerCase() === me);

  // Self verified-identity check, driving the "become a builder" nudge for
  // legacy un-revealed accounts that still rank. `null` = chain confirmed no
  // binding (still showing a truncated H160 on the board); `undefined` = not
  // known yet (suppress the banner until confirmed so it never flashes). A
  // builder (string) needs no nudge.
  const { username: selfUsername } = useRootUsername(
    (currentUserAddr ?? undefined) as `0x${string}` | undefined,
  );
  // Show the nudge once the connected user is ranked AND not yet a builder.
  // `displayNameForAccount(null, …)` is exactly the label their row shows.
  const showRevealNudge = meOnBoard && !fullscreen && selfUsername === null;
  const selfLabel = currentUserAddr
    ? displayNameForAccount(null, currentUserAddr)
    : "";

  // Scroll the user's own row into view AND blink it. scrollIntoView is a no-op
  // when the row is already visible, so the blink is what signals "this is you"
  // either way. Driven via the Web Animations API so it restarts on every click
  // and isn't clobbered by React re-renders touching the row's className.
  const findMe = useCallback(() => {
    const el = meRowRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Blink: the row is white-on-dark at rest; flash its fill to transparent and
    // its text to white a few times so it reads like a quick blink. Driven via
    // WAAPI (not a CSS class) so it restarts each click and survives React
    // re-renders touching the row's className. End frames match the resting
    // state, so no fill mode is needed.
    const blink = () => {
      const opts: KeyframeAnimationOptions = {
        duration: 180,
        iterations: reduce ? 1 : 3,
        easing: "ease-in-out",
      };
      el.animate(
        [{ backgroundColor: "#fff" }, { backgroundColor: "transparent" }, { backgroundColor: "#fff" }],
        opts,
      );
      el.querySelectorAll(
        ".leaderboard-rank, .leaderboard-name, .leaderboard-xp, .leaderboard-profile-link, .leaderboard-you-badge",
      ).forEach((t) =>
        t.animate([{ color: "#0d0d0f" }, { color: "#fff" }, { color: "#0d0d0f" }], opts),
      );
    };

    // Blink only once the row has settled into view — otherwise a long smooth
    // scroll finishes the animation before the row is even on screen. The
    // observer fires immediately when the row is already visible, so every click
    // blinks. A timeout is the safety net if it never reaches full visibility.
    let done = false;
    let timer = 0;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.95)) return;
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        blink();
      },
      { threshold: [0.95] },
    );
    obs.observe(el);
    timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      obs.disconnect();
      blink();
    }, 1200);

    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }, []);

  // Resolve usernames incrementally and accumulate them. Each scrolled page
  // queries only its *unresolved* addresses (those not already in the map) —
  // querying all accumulated addresses on every append would be O(n²) over a
  // full scroll. A refresh clears the cache so the rebuilt list re-resolves.
  const [usernames, setUsernames] = useState<Map<string, string | null>>(new Map());
  useEffect(() => { setUsernames(new Map()); }, [refreshKey]);

  const unresolvedAddresses = useMemo(
    () =>
      entries
        .map((e) => e.account.toLowerCase() as `0x${string}`)
        .filter((a) => !usernames.has(a)),
    [entries, usernames],
  );
  const resolvedPage = useRootUsernamesBatch(unresolvedAddresses, refreshKey);
  useEffect(() => {
    if (resolvedPage.size === 0) return;
    setUsernames((prev) => {
      const next = new Map(prev);
      for (const [addr, name] of resolvedPage) next.set(addr, name);
      return next;
    });
  }, [resolvedPage]);

  // Persist page 0 for the next mount's snapshot paint. Gated on a completed
  // live fetch (revalidatedRef) so a failed refresh never rewrites the blob.
  // Names merge live-over-cached: the first write often lands before the
  // batch username read, and must not clobber cached names with an empty map.
  useEffect(() => {
    if (loading || !revalidatedRef.current || entries.length === 0) return;
    const page = entries.slice(0, PAGE_SIZE);
    const names = new Map<string, string | null>();
    for (const e of page) {
      const addr = e.account.toLowerCase();
      const name = usernames.has(addr) ? usernames.get(addr) : snapshot?.usernames.get(addr);
      if (name !== undefined) names.set(addr, name ?? null);
    }
    writeLeaderboardSnapshot(page, names);
  }, [loading, entries, usernames, snapshot]);

  return (
    <div className="tab tab-leaderboard" data-testid="leaderboard" data-loading={loading && entries.length === 0 ? "true" : "false"}>
      {showBecomeBuilder && !fullscreen && <BecomeBuilderCard />}
      <div className="tab-center">
        <header className="tab-header">
          <div className="leaderboard-title-row">
            <h1 className="tab-title">Leaderboard</h1>
            <div className="leaderboard-header-actions">
              {meOnBoard && !fullscreen && (
                <button
                  type="button"
                  className="leaderboard-find-btn"
                  onClick={findMe}
                >
                  <LocateFixed size={15} strokeWidth={2.5} />
                  Find me
                </button>
              )}
              <button
                type="button"
                className="leaderboard-fs-btn"
                onClick={() => setFullscreen((v) => !v)}
                aria-pressed={fullscreen}
              >
                {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                {fullscreen ? "Exit fullscreen" : "Fullscreen"}
              </button>
            </div>
          </div>
          <p className="tab-lead">
            Top builders by XP. You earn XP when you deploy an app, when someone mods your app, and when someone stars it.
          </p>
          <Link className="leaderboard-xp-link" to="/?section=xp-prizes">
            How XP &amp; Prizes work →
          </Link>
        </header>

        {fullscreen && (
          <div className="leaderboard-fs-title" aria-hidden="true">
            playground.dot
          </div>
        )}

        {showRevealNudge && (
          <Link
            className="leaderboard-reveal-nudge"
            to="/become-builder"
            data-testid="leaderboard-reveal-nudge"
          >
            Listed as <strong>{selfLabel}</strong>; become a builder?
          </Link>
        )}

        <div className="leaderboard-fs-stage" data-widget-layout={widgetLayout} ref={stageRef}>
        <section className="leaderboard-card">
          <div className="leaderboard-colhead" role="row">
            <span>Rank</span>
            <span>Builder</span>
            <span className="leaderboard-col-xp">XP</span>
          </div>

          {entries.length === 0 ? (
            <p className="leaderboard-empty" data-testid="leaderboard-empty">
              <em>{loading ? "Loading…" : "No points awarded yet. Publish an app to earn launch XP."}</em>
            </p>
          ) : (
            <ol ref={listRef} className="leaderboard-list" data-testid="leaderboard-list">
              {entries.map((e, i) => {
                const isYou = !!me && e.account.toLowerCase() === me;
                // Map miss = batch read hasn't landed yet → fall back to the
                // snapshot's cached name instead of "…". A confirmed live
                // value (including a confirmed null) always wins once it
                // lands; only a confirmed null reaches the generated name.
                const addr = e.account.toLowerCase();
                const username = usernames.has(addr)
                  ? usernames.get(addr)
                  : snapshot?.usernames.get(addr);
                const label = displayNameForAccount(username, e.account);
                return (
                  <li
                    key={e.account}
                    ref={isYou ? meRowRef : undefined}
                    className={`leaderboard-row${isYou ? " leaderboard-row-me" : ""}`}
                    data-testid="leaderboard-row"
                    data-rank={i + 1}
                    data-rank-hue={i % 5}
                    data-account={e.account}
                    data-username={username ?? ""}
                    data-is-you={isYou ? "true" : "false"}
                  >
                    <span className="leaderboard-rank">{i + 1}</span>
                    <Link
                      className="leaderboard-name leaderboard-profile-link"
                      title={label}
                      to={profilePathForAccount(e.account)}
                      data-testid="leaderboard-profile-link"
                    >
                      {label}
                      {isYou && <span className="leaderboard-you-badge">you</span>}
                    </Link>
                    <span className="leaderboard-xp">{e.score.toString()}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {loadingMore && (
            <div className="spinner" data-testid="leaderboard-loading-more">Loading…</div>
          )}
          {hasMore && entries.length > 0 && (
            <div
              ref={sentinelRef}
              className="sentinel"
              data-testid="leaderboard-sentinel"
            />
          )}
        </section>

        {/* Venue-only: two app leaderboards (rank APPS by stars / mods, not
            users). "side" pins them beside the board, each scrolling on its own
            loop; "bottom" places them in the board's scroller as a footer. */}
        {fullscreen && (
          <aside className="leaderboard-fs-widgets">
            <SideWidget kind="stars" title="Crowd favourites: most starred apps" enabled={fullscreen} autoScroll={widgetLayout === "side"} refreshKey={refreshKey} />
            <SideWidget kind="mods" title="Builder favourites: most modded apps" enabled={fullscreen} autoScroll={widgetLayout === "side"} refreshKey={refreshKey} />
          </aside>
        )}
        </div>{/* .leaderboard-fs-stage */}

        {!hasMore && !loading && entries.length > 0 && (
          <BackToTop note="That's the full board.">
            {meOnBoard && (
              <button type="button" className="back-to-top-btn" onClick={findMe}>
                <LocateFixed size={15} strokeWidth={2.5} />
                Find me
              </button>
            )}
          </BackToTop>
        )}
      </div>
    </div>
  );
}
