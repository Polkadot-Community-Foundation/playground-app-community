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

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { Check, X, RectangleHorizontal, Columns2, Rows3, type LucideIcon } from "lucide-react";
import { AppCard, type AppDetails, type AppsSort } from "./App";
import type { AppEntry } from "./registryTypes";
import { useIntersectionObserver, usePageHasOverflow, useIsMobile } from "./utils";
import { loadAppsView, saveAppsView, type AppsView } from "./utils/appsView.ts";
import { FILTER_TAGS, SITE, filterBucket } from "./utils/appsFilter.ts";
import { XP_VALUES } from "./xpValues";
import ErrorBanner from "./ErrorBanner.tsx";
import BackToTop from "./BackToTop";
import BecomeBuilderCard from "./BecomeBuilderCard";
import { useOnboarding } from "./OnboardingProvider";
import { addUiBreadcrumb } from "./lib/telemetry";

// Points at the tutorial Journey Card on the Playground page via the shared
// `?section=<id>` cross-route deep link (honoured by PlaygroundTab's mount
// effect → scrollToSection), not the tutorial app's detail panel.
const TUTORIAL_HREF = "/?section=tutorial";

const PAGE = 12;

const SORT_OPTIONS: { id: AppsSort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "stars", label: "Most starred" },
  { id: "mods", label: "Most modded" },
];

const VIEW_OPTIONS: { id: AppsView; label: string; Icon: LucideIcon }[] = [
  { id: "1col", label: "One per row", Icon: RectangleHorizontal },
  { id: "2col", label: "Two per row", Icon: Columns2 },
  { id: "thin", label: "Compact list", Icon: Rows3 },
];

type Props = {
  entries: AppEntry[];
  pinnedEntries: AppEntry[];
  pinnedDomains: Set<string>;
  loading: boolean;
  loadStalled: boolean;
  loadError: string | null;
  loadTimedOut: boolean;
  hasMore: boolean;
  detailsRef: MutableRefObject<Map<string, AppDetails>>;
  detailsVersion: number;
  loadMore: () => void;
  handleSelectEntry: (entry: AppEntry) => void;
  retryLoad: () => void;
  reviewer?: string;
  onStar: (domain: string) => Promise<void>;
  sortBy: AppsSort;
  onSortChange: (next: AppsSort) => void;
};

export default function AppsTab({
  entries,
  pinnedEntries,
  pinnedDomains,
  loading,
  loadStalled,
  loadError,
  loadTimedOut,
  hasMore,
  detailsRef,
  detailsVersion,
  loadMore,
  handleSelectEntry,
  retryLoad,
  reviewer,
  onStar,
  sortBy,
  onSortChange,
}: Props) {
  const [search, setSearch] = useState("");
  // Additive multi-select category filter. The set holds the categories the
  // user has explicitly switched ON (the real TAGS plus the UNTAGGED
  // pseudo-bucket). Default = empty = no filtering (show everything). A
  // non-empty set is strict-include UNION over the app's bucket: every app maps
  // to exactly one bucket (its recognised TAG, else UNTAGGED), so it's shown
  // only when its bucket is in the set. Clicking a pill adds/removes its
  // category; "remove filters" clears the whole set back to show-all.
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set());
  const anyTagSelected = selectedTags.size > 0;
  const [moddableOnly, setModdableOnly] = useState(false);
  // Standalone "Show sites" toggle for static `.dot` sites. `site` is no longer
  // a category pill — this controls whether site cards appear at all. ON
  // (default) mixes sites into the grid alongside everything else; OFF hides
  // them. Independent of the category pills, so "Show sites on + a tag selected"
  // = sites UNION that tag. The footer Sites chip produces a sites-only view by
  // also selecting the `site` bucket (which excludes every non-site card).
  const [siteOn, setSiteOn] = useState(true);
  const [hiwDrawerOpen, setHiwDrawerOpen] = useState(false);
  // Grid density preference (persisted; time-seeded on first access). On mobile
  // we force the single-column feed regardless of the stored choice.
  const [view, setView] = useState<AppsView>(() => loadAppsView());
  const isMobile = useIsMobile();
  const effectiveView: AppsView = isMobile ? "1col" : view;
  const changeView = (next: AppsView) => {
    setView(next);
    saveAppsView(next);
    addUiBreadcrumb("Apps view", { view: next });
  };
  // Onboarding banner: shown above everything until the connected account has
  // network resources; disappears the moment they do.
  const { account: onboardingAccount, hasResources } = useOnboarding();
  const showBecomeBuilder = !!onboardingAccount && !hasResources;
  const sentinelRef = useIntersectionObserver(loadMore, hasMore && !loading);
  // The end-of-list "back to top" band only earns its place when the page
  // actually scrolls — if every app fits on screen there's nothing to go back from.
  const pageScrolls = usePageHasOverflow();

  const [searchParams] = useSearchParams();
  const catParam = searchParams.get("cat");
  useEffect(() => {
    if (catParam === null) return;
    // ?cat=site is no longer a category pill — the footer's Sites chip lands the
    // grid in a sites-only view: Show sites on (so site cards render) plus the
    // `site` bucket selected (so every non-site card is filtered out).
    if (catParam === SITE) {
      setSiteOn(true);
      setSelectedTags(new Set([SITE]));
      return;
    }
    // The footer's ?cat= value is already a canonical lowercase TAG (and
    // ?cat=untagged is also honoured). A valid one lands the grid in
    // single-category view (set = just that bucket); an unknown value resets to
    // "show everything" (empty set).
    if ((FILTER_TAGS as readonly string[]).includes(catParam)) setSelectedTags(new Set([catParam]));
    else setSelectedTags(new Set());
  }, [catParam]);

  const filtered = useMemo(() => {
    const filter = (e: AppEntry) => {
      const details = detailsRef.current.get(e.domain);
      const bucket = filterBucket(details?.metadata?.tag);
      // Sites have no category pill of their own — the "Show sites" toggle alone
      // decides whether a site card appears (default on). Non-site cards follow
      // the normal tag rule: empty set = show all, non-empty set = strict-include
      // UNION over the card's bucket. The footer's sites-only view rides this by
      // selecting the `site` bucket, which leaves every non-site card excluded
      // while the toggle keeps the site cards visible.
      const tagPass =
        bucket === SITE ? siteOn : !anyTagSelected || selectedTags.has(bucket);
      if (!tagPass) return false;
      if (moddableOnly && !details?.metadata?.repository) return false;
      if (search) {
        const q = search.toLowerCase();
        const name = (details?.metadata?.name ?? e.domain).toLowerCase();
        if (!name.includes(q) && !e.domain.toLowerCase().includes(q)) return false;
      }
      return true;
    };
    // Ordering for `entries` comes from the on-chain read method that App.tsx
    // invoked (getApps / getTopStarred / getTopModded). In "newest" the curated
    // pinned apps stay at the top; in the ranked sorts (stars/mods) they mix in
    // at their real position. A pinned app that has been starred/modded appears
    // in `entries` (getTopStarred/getTopModded return it) but without the pinned
    // flag — mark it by domain so the featured styling/chip still shows.
    if (sortBy === "newest") {
      const pinned = pinnedEntries.filter(filter);
      const rest = entries.filter(e => !pinnedDomains.has(e.domain)).filter(filter);
      return [...pinned, ...rest];
    }
    const ranked = entries.filter(filter).map(e =>
      pinnedDomains.has(e.domain) && !e.pinned ? { ...e, pinned: true } : e
    );
    // Cold start: the ranked on-chain indexes only hold apps with a non-zero
    // star/mod count, so before anyone has starred or modded anything the page
    // is empty. Fall back to the curated pinned apps (keeping their featured
    // styling) so the grid isn't blank. Once any app earns a star/mod, the
    // ranked order takes over and an as-yet-unstarred pinned app ranks nowhere.
    if (ranked.length === 0) return pinnedEntries.filter(filter);
    return ranked;
    // detailsVersion intentionally in deps so metadata-driven filters re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, pinnedEntries, pinnedDomains, sortBy, selectedTags, anyTagSelected, moddableOnly, siteOn, search, detailsVersion]);

  // Stable two-column split for the "2col" view. A card's column is keyed on its
  // (immutable) domain, decided the first time we see it and remembered for the
  // session — NOT on its array index. `filtered` is mutated by far more than
  // pagination appends: live publish events prepend at index 0 (App.tsx
  // upsertEntry/prependEntry), unpublish removes mid-array, pin/unpin and
  // late-arriving metadata reorder it. Index-parity would flip a card's column
  // on any of these and reshuffle the grid. Keying on domain means inserts and
  // removals only grow/shrink a column in place — an already-placed card never
  // jumps columns. New domains go to whichever column is currently shorter, so
  // the two stay balanced while preserving newest-first reading order.
  const colByDomain = useRef<Map<string, 0 | 1>>(new Map());

  // Rebalance the two columns whenever the user changes a filter/sort control:
  // clearing the sticky map lets the `columns` memo below rebuild an even split
  // over the now-visible set (otherwise filtering out cards leaves the survivors
  // wherever they were assigned and one column runs much longer). Only filter/sort
  // inputs are in the signature — NOT entries/pinned/detailsVersion — so
  // pagination appends, live publish/unpublish events and metadata backfill stay
  // incremental and never reshuffle.
  const filterSig =
    `${sortBy}|${moddableOnly}|${siteOn}|${search}|` +
    `${[...selectedTags].sort().join(",")}`;
  const prevFilterSig = useRef(filterSig);
  if (prevFilterSig.current !== filterSig) {
    prevFilterSig.current = filterSig;
    colByDomain.current = new Map();
  }

  const columns = useMemo<[AppEntry[], AppEntry[]] | null>(() => {
    if (effectiveView !== "2col") return null;
    const assign = colByDomain.current;
    const cols: [AppEntry[], AppEntry[]] = [[], []];
    for (const entry of filtered) {
      let col = assign.get(entry.domain);
      if (col === undefined) {
        col = cols[0].length <= cols[1].length ? 0 : 1;
        assign.set(entry.domain, col);
      }
      cols[col].push(entry);
    }
    return cols;
  }, [filtered, effectiveView]);

  return (
    <div className="tab tab-apps" data-testid="tab-apps">
      {showBecomeBuilder && <BecomeBuilderCard />}
      <div className="tab-center">
        <header className="tab-header">
          <h1 className="tab-title">Apps</h1>
          <p className="tab-lead">
            Every app is designed to be modded. Pick a starting point, customise with AI, deploy. Tap stars to rate.
          </p>
        </header>
        {!isMobile && (
          <div className="apps-viewbar">
            <div className="view-toggle" role="radiogroup" aria-label="Grid layout" data-testid="view-toggle">
              {VIEW_OPTIONS.map(({ id, label, Icon }) => {
                const isActive = view === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`view-toggle-btn${isActive ? " active" : ""}`}
                    role="radio"
                    aria-checked={isActive}
                    aria-label={label}
                    title={label}
                    data-view={id}
                    data-active={isActive ? "true" : "false"}
                    data-testid="view-toggle-btn"
                    onClick={() => changeView(id)}
                  >
                    <Icon size={18} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {loadError && (
          <ErrorBanner
            title="Couldn't load apps."
            message={loadError}
            testid="load-error"
            // A timed-out (wedged) connection can't be recovered by re-running
            // the query in-app — only a manual reload helps — so we drop Retry
            // and the message asks the user to reload. Ordinary errors keep it.
            onRetry={loadTimedOut ? undefined : retryLoad}
          />
        )}
        {/* Liveness hint ABOVE the skeletons so it's seen without scrolling
            past a full screen of placeholders. The load is never aborted here
            — if it's merely slow it self-heals when the data lands; if it's
            wedged, a reload is the only fix in the host (window.location.reload
            is a no-op there), so we ask. */}
        {filtered.length === 0 && loading && loadStalled && (
          <p className="grid-load-hint" role="status" aria-live="polite" data-testid="grid-load-hint">
            This is taking longer than usual. Try reloading the page.
          </p>
        )}
        <div className="grid" data-testid="app-grid" data-view={effectiveView}>
          {columns ? (
            // Two fixed columns; each card's column is keyed on its domain (see
            // the `columns` memo) so live inserts/removals never reshuffle the
            // grid — unlike a CSS multi-column layout, which rebalances every
            // card on each append.
            columns.map((colEntries, col) => (
              <div className="grid-col" key={`col-${col}`}>
                {colEntries.map(entry => (
                  <AppCard
                    key={entry.domain}
                    entry={entry}
                    details={detailsRef.current.get(entry.domain)}
                    onSelect={handleSelectEntry}
                    reviewer={reviewer}
                    onStar={onStar}
                  />
                ))}
                {filtered.length === 0 && loading &&
                  Array.from({ length: PAGE / 2 }, (_, i) => (
                    <div key={`skel-${col}-${i}`} className="card card-skeleton" />
                  ))
                }
              </div>
            ))
          ) : (
            <>
              {filtered.map(entry => (
                <AppCard
                  key={entry.domain}
                  entry={entry}
                  details={detailsRef.current.get(entry.domain)}
                  onSelect={handleSelectEntry}
                  reviewer={reviewer}
                  onStar={onStar}
                />
              ))}
              {filtered.length === 0 && loading &&
                Array.from({ length: PAGE }, (_, i) => (
                  <div key={`skel-${i}`} className="card card-skeleton" />
                ))
              }
            </>
          )}
        </div>
        {loading && filtered.length > 0 && (
          <div className="spinner" data-testid="loading-spinner">Loading...</div>
        )}
        {!loading &&
          filtered.length === 0 &&
          (entries.length > 0 || pinnedEntries.length > 0) &&
          (search || anyTagSelected || moddableOnly || !siteOn) && (
            <div className="empty" data-testid="empty-state-filtered">
              No apps match your filters.
              {moddableOnly && " Try turning off \"Moddable only\"."}
              {!siteOn && " Try turning on \"Show sites\"."}
              {anyTagSelected && " Try removing a category filter."}
              {search && " Try clearing the search."}
            </div>
          )}
        {!hasMore &&
          filtered.length === 0 &&
          !loading &&
          !loadError &&
          !search &&
          !anyTagSelected &&
          !moddableOnly &&
          siteOn && (
            // No filter/search is active, so an empty grid is the backing read
            // itself coming back empty. For the `stars`/`mods` sorts that means
            // the on-chain index is empty (nothing starred/modded yet) — NOT an
            // empty registry, so don't claim "no apps registered". Only `newest`
            // (getApps over the whole registry) can truthfully say that.
            <div className="empty" data-testid="empty-state">
              {sortBy === "mods"
                ? "No modded apps yet."
                : sortBy === "stars"
                ? "No starred apps yet."
                : "No apps registered yet."}
            </div>
          )}
        {hasMore && (
          <div ref={sentinelRef} className="sentinel" data-testid="infinite-scroll-sentinel" />
        )}
        {!hasMore && !loading && filtered.length > 0 && pageScrolls && (
          <BackToTop note="You've reached the end. That's every app." />
        )}
      </div>

      <aside className="tab-right-rail" data-testid="tab-right-rail">
        <button
          type="button"
          className="btn-primary btn-primary--how-it-works"
          onClick={() => setHiwDrawerOpen(true)}
          aria-haspopup="dialog"
          data-testid="how-it-works-trigger"
        >
          How it works
        </button>

        <form
          role="search"
          className="search-bar tab-rail-search"
          onSubmit={e => e.preventDefault()}
        >
          <input
            type="text"
            className="search-input"
            placeholder="Filter by name or domain…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter apps"
            data-testid="search-input"
          />
          {search && (
            <button
              className="search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear filter"
              type="button"
            >
              ×
            </button>
          )}
        </form>

        <div className="filters tab-rail-sort" data-testid="apps-sort" role="radiogroup" aria-label="Sort apps">
          {SORT_OPTIONS.map(opt => {
            const isActive = sortBy === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`filter-pill${isActive ? " active" : ""}`}
                onClick={() => {
                  if (isActive) return;
                  addUiBreadcrumb("Sort apps", { sortBy: opt.id });
                  onSortChange(opt.id);
                }}
                data-testid="sort-pill"
                data-sort={opt.id}
                data-active={isActive ? "true" : "false"}
                role="radio"
                aria-checked={isActive}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Top-level toggles, above the category pills: the standalone Show
            sites toggle and Moddable-only. Both are checkbox pills (distinct
            from the tag pills) — they narrow/widen the grid orthogonally to the
            categories below. */}
        <div className="filters tab-rail-toggles" data-testid="apps-toggles">
          <button
            type="button"
            className={`filter-pill${siteOn ? " active" : ""}`}
            data-tag="site"
            onClick={() => {
              const next = !siteOn;
              addUiBreadcrumb("Filter site", { siteOn: next });
              setSiteOn(next);
            }}
            data-testid="filter-site-toggle"
            data-active={siteOn ? "true" : "false"}
            aria-pressed={siteOn}
          >
            <span className="filter-pill-check" aria-hidden="true">
              <Check size={10} strokeWidth={3} />
            </span>
            Show sites
          </button>
          <button
            type="button"
            className={`filter-pill${moddableOnly ? " active" : ""}`}
            data-tag="moddable"
            onClick={() => {
              const next = !moddableOnly;
              addUiBreadcrumb("Filter moddable", { moddableOnly: next });
              setModdableOnly(next);
            }}
            data-testid="filter-moddable-toggle"
            data-active={moddableOnly ? "true" : "false"}
            aria-pressed={moddableOnly}
          >
            <span className="filter-pill-check" aria-hidden="true">
              <Check size={10} strokeWidth={3} />
            </span>
            Moddable only
          </button>
        </div>

        <div className="filters tab-rail-filters" data-testid="apps-filters">
          {/* One persistent element on its own row (full-width flex item) so
              the pills below never reflow. It's always the same <button>: while
              nothing is selected it reads "filters" with a transparent border
              and is inert; the moment ≥1 category is on it reads "remove
              filters", its border fades in and it becomes clickable to clear. */}
          <div className="filters-head">
            <button
              type="button"
              className={`filters-toggle${anyTagSelected ? " is-clearable" : ""}`}
              onClick={() => {
                if (!anyTagSelected) return;
                addUiBreadcrumb("Filter tag", { selected: [] });
                setSelectedTags(new Set());
              }}
              data-testid="filters-toggle"
              data-active={anyTagSelected ? "true" : "false"}
              aria-disabled={!anyTagSelected}
              aria-label={anyTagSelected ? "Remove all category filters" : "Filters"}
            >
              {anyTagSelected ? "remove filters" : "filters"}
            </button>
          </div>
          {FILTER_TAGS.map(tag => {
            // Each tag pill (including the Untagged pseudo-bucket) reflects its
            // own membership and toggles itself in/out of the selected set.
            const isActive = selectedTags.has(tag);
            return (
              <button
                key={tag}
                className={`filter-pill${isActive ? " active" : ""}`}
                onClick={() => {
                  setSelectedTags(prev => {
                    const next = new Set(prev);
                    if (next.has(tag)) next.delete(tag);
                    else next.add(tag);
                    addUiBreadcrumb("Filter tag", { selected: [...next] });
                    return next;
                  });
                }}
                data-testid="filter-pill"
                data-tag={tag}
                data-active={isActive ? "true" : "false"}
                aria-pressed={isActive}
                aria-label={isActive ? `Hide ${tag}` : `Show ${tag}`}
              >
                {tag.charAt(0).toUpperCase() + tag.slice(1)}
              </button>
            );
          })}
        </div>

        <aside className="feat-card" data-testid="how-it-works">
          <h3>How it works</h3>
          <p className="feat-card-body">
            Every app here is live on a decentralised network. Launch one to try it, mod open-source apps, and star your favourites to help them win. Ready to build your own? Start with the{" "}
            <Link className="pitch-link" to={TUTORIAL_HREF}>
              tutorial
            </Link>
            .
          </p>
        </aside>

        <aside className="feat-card" data-testid="give-receive-stars">
          <h3>Give and receive stars</h3>
          <p className="feat-card-body">
            Give stars to help creators win. Earn {XP_VALUES.starReceived} XP for every star your app receives.
          </p>
        </aside>
      </aside>

      {hiwDrawerOpen && createPortal(
        <div
          className="drawer-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hiw-drawer-title"
          onClick={() => setHiwDrawerOpen(false)}
          data-testid="how-it-works-drawer"
        >
          <div className="drawer" onClick={e => e.stopPropagation()}>
            <h3 id="hiw-drawer-title">How it works</h3>
            <p>
              Every app here is live on a decentralised network. Launch one to try it, mod open-source apps, and star your favourites to help them win. Ready to build your own? Start with the{" "}
              <Link
                className="pitch-link"
                to={TUTORIAL_HREF}
                onClick={() => setHiwDrawerOpen(false)}
              >
                tutorial
              </Link>
              .
            </p>
            <h3 className="drawer-section">Give and receive stars</h3>
            <p>
              Give stars to help creators win. Earn {XP_VALUES.starReceived} XP for every star your app receives.
            </p>
            <button
              type="button"
              className="btn-ghost drawer-close"
              onClick={() => setHiwDrawerOpen(false)}
            >
              Close
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
