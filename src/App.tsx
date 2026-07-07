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

import { useState, useEffect, useCallback, useRef, memo, Suspense, type CSSProperties } from "react";
import { Link, Navigate, Routes, Route, useParams, useLocation, useNavigate } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { calculateCid } from "@parity/product-sdk-cloud-storage";
import {
  runTx,
  useSignerState,
  registryReady,
  getBulletinClient,
  storeBytesViaHost,
  ensureSignerReady,
  useIconUrl,
  resolveProfileIdentifier,
  displayNameForAccount,
  profileHueForAccount,
  isH160Address,
  isInsufficientFundsError,
  stringify,
  readmeBlurb,
  type SignerState,
} from "./utils";
import {
  useRootUsername,
  revalidateRootIdentities,
} from "./utils/identity.ts";
import { markIdentityBonusClaimed } from "./utils/identityBonus.ts";
import { lazyRetry } from "./utils/lazyRetry.ts";
import { cardColorForDomain } from "./utils/placeholders.ts";
import { withDeadline, withReadDeadline, DeadlineError, READ_DEADLINE_MS } from "./utils/deadline.ts";
import { guardedWrite, isNotABuilderError } from "./utils/guardedWrite.ts";
import { OnboardingProvider, useOnboarding } from "./OnboardingProvider.tsx";
import LockedHint from "./LockedHint.tsx";
import { QUEST_COLORS } from "./questPalette.ts";
import LaunchButton from "./LaunchButton.tsx";
import { ArrowLeft, Shuffle, Share2 } from "lucide-react";
import { CLI_COMMAND, INSTALL_CMD, PLAYGROUND_URL } from "./config.ts";
import { StarIcon, PinIcon, CopyIcon, CheckIcon } from "./icons.tsx";
import ModPopup from "./ModPopup.tsx";
import GrainCanvas from "./GrainCanvas.tsx";
import AppDetailPanel from "./AppDetailPanel.tsx";
import Leaderboard from "./Leaderboard.tsx";
import PointsBreakdown from "./PointsBreakdown.tsx";
import SectionBoundary from "./SectionBoundary.tsx";
import { LoadingFallback } from "./LoadingFallback.tsx";
import ErrorBanner from "./ErrorBanner.tsx";
import LeftRail from "./LeftRail.tsx";
import PlaygroundTab from "./PlaygroundTab.tsx";
import AboutTab from "./AboutTab.tsx";
import AppsTab from "./AppsTab.tsx";
import ProfileTab from "./ProfileTab.tsx";
import { fetchAppData, fetchAppDataBatch } from "./registryAppData.ts";
import EventStream from "./utils/event-stream/EventStream.tsx";
import {
  journeyTracker,
  SpanOp,
  addUiBreadcrumb,
  addUserActionBreadcrumb,
  addAdminActionBreadcrumb,
  isSigningRejection,
} from "./lib/telemetry";
import {
  handleRegistryEvent,
  upsertEntry,
  removeEntry,
} from "./registryEventReducer";
import {
  runPublishFlow,
  type PublishStatus,
} from "./publishFlow";
import { runVisibilityToggle } from "./visibilityToggle";
import {
  playgroundEventStream,
  isRegistryEventStreamItem,
} from "./utils/event-stream/index.ts";
import { XpCelebration } from "./XpCelebration.tsx";
import { celebrationForEvent, type XpCelebrationSpec } from "./xpCelebration.ts";

// The embedded site builder (/builder) is its own lazy chunk — its editor +
// chain stack never load unless the route is visited.
const BuilderTab = lazyRetry(() => import("./builder/index.tsx"));

const PAGE = 12;
const PAGE_LOAD_WATCHDOG_MS = 8000;

// Liveness hint for the FIRST page load, shown over the skeletons when the
// initial chain read runs long. A healthy load lands in 1-3s, so 10s is well
// clear of the common case: we suggest a manual page reload, which is the only
// real recovery in the host — window.location.reload() is a no-op there, so we
// ASK the user rather than reload for them. The hard backstop is the
// READ_DEADLINE_MS (45s) deadline on the chain reads themselves, after which
// the load rejects into the error banner.
const APPS_LOAD_RELOAD_HINT_MS = 10_000;

// Render-time fix for legacy mis-spelled metadata.tag values published before the moddable rename.
const TAG_SPELLING_FIXES: Record<string, string> = {
  modable: "moddable",
};
// Site Builder deploys carry `tag: "site"` — both the dot-site quest's detection
// signal (see utils/useTaskProgress.ts, which reads the raw metadata tag) and now
// a first-class Apps-grid category, so static-site deploys render a "site" chip
// and can be filtered like any other category.
const displayTag = (tag?: string): string | undefined =>
  tag ? TAG_SPELLING_FIXES[tag] ?? tag : undefined;

const ZERO_H160 = `0x${"0".repeat(40)}`;

/**
 * Normalise an H160 returned from the registry into either an undefined
 * (entry has no recorded value) or a lowercase 0x-prefixed string. The
 * contract uses `unwrap_or_default()` for missing-info fallbacks so the
 * zero address surfaces as a placeholder, not a real owner.
 */
const normalizeAddress = (raw: unknown): string | undefined => {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).toLowerCase();
  return s === ZERO_H160 ? undefined : s;
};

// Dedupes concurrent fetches for the same CID/domain. Resolved values are
// cached in detailsRef by callers; these maps only guard against parallel
// requests racing before any of them populate that cache.
const _metadataInFlight = new Map<string, Promise<AppMetadata | null>>();
function fetchMetadata(cid: string): Promise<AppMetadata | null> {
  const existing = _metadataInFlight.get(cid);
  if (existing) return existing;
  const p = (async (): Promise<AppMetadata | null> => {
    try {
      const client = await getBulletinClient();
      // Deadline the fetch: past a healthy connect a single fetchJson can hang
      // on a wedged host bridge, which would pin this CID's in-flight entry —
      // and the tile/panel awaiting it — forever. A timeout falls through to
      // the same null the host-unavailable path returns.
      return await withReadDeadline(client.fetchJson<AppMetadata>(cid), "Bulletin metadata fetch");
    } catch {
      // Outside the Polkadot host, fetchJson throws CloudStorageHostUnavailableError.
      // See "Container-only delivery" in CLAUDE.md.
      return null;
    }
  })().finally(() => _metadataInFlight.delete(cid));
  _metadataInFlight.set(cid, p);
  return p;
}

// Query param (not hash) because some chat/share unfurlers strip fragments,
// which would break the post-deploy "Share your app" CTA.
function getAppFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("app");
}

// replaceState (not pushState) — Polkadot Desktop's shell intercepts the
// back button at the chrome level; it never reaches the iframe, so we can't
// hook back-closes-panel via popstate. Pushing history entries we can't pop
// is worse than not pushing at all. The URL still reflects the open panel
// for sharing; close is via the X button.
function setAppInUrl(domain: string | null) {
  const url = new URL(window.location.href);
  if (domain) url.searchParams.set("app", domain);
  else url.searchParams.delete("app");
  window.history.replaceState({}, "", url.toString());
}

// Build a shareable URL for an app. Always uses the canonical public host
// (PLAYGROUND_URL) so a link copied from inside Polkadot Desktop, from a
// localhost dev session, or from a PR-preview .dot.li gateway still resolves
// when pasted into any web2 chat client. Lands on /apps so closing the detail
// panel leaves the visitor on the grid (not the Playground homepage).
export function buildAppShareUrl(domain: string): string {
  const url = new URL("/apps", PLAYGROUND_URL);
  url.searchParams.set("app", domain);
  return url.toString();
}

/// Look up a single app's data by domain. The returned entry has no `index`
/// set — callers that need the slot index must supply it from a paginated
/// query result.
async function fetchAppEntry(domain: string): Promise<AppEntry | null> {
  // Deadlined + catch→null. This was the one read helper that neither bounded
  // its queries nor caught: a wedged host bridge left it pending forever, and
  // its callers (deep-link open at mount, handleSelectByDomain, the MyApps
  // loop, AppDetailPanel's fetchEntry) would hang or — for the bare `.then`
  // deep-link path — eat an unhandled rejection. null is already the documented
  // "not found" return every caller handles (`if (!entry) …`), so a timeout
  // degrades to the same graceful path. Reads are idempotent; a re-open retries.
  try {
    const data = await fetchAppData(domain);
    if (!data?.metadataUri) return null;
    return {
      domain,
      metadataUri: data.metadataUri,
      owner: data.owner,
      visibility: data.visibility,
      publisher: data.publisher,
    };
  } catch (cause) {
    console.warn(`[playground] fetchAppEntry(${domain}) failed — ${stringify(cause)}`);
    return null;
  }
}

async function checkIsAdmin(address: string): Promise<boolean> {
  try {
    const registry = await registryReady;
    const res = await withReadDeadline(registry.isAdmin.query(address), "Registry isAdmin");
    return res.success && res.value === true;
  } catch {
    return false;
  }
}

// Coalesce concurrent reads for the same (voter, domain) — the grid backfill
// and the account-switch refetch can both ask for a domain at once. Mirrors
// `_socialInFlight`. Keyed on voter:domain so a different account doesn't hit
// a stale entry.
const _hasStarredInFlight = new Map<string, Promise<boolean>>();
function fetchHasStarred(domain: string, voter: string): Promise<boolean> {
  const key = `${voter}:${domain}`;
  const existing = _hasStarredInFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      return (await fetchAppData(domain, voter))?.hasStarred ?? false;
    } catch (cause) {
      console.warn(
        `[playground] fetchHasStarred(${domain}, ${voter}) threw — ${stringify(cause)}`,
      );
      return false;
    } finally {
      _hasStarredInFlight.delete(key);
    }
  })();
  _hasStarredInFlight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppMetadata {
  name?: string;
  description?: string;
  repository?: string;
  icon_cid?: string;
  // 2:1 hero cover image, owner-editable from the App Detail Page. Falls back
  // to icon_cid when unset so apps that never set a cover keep their current
  // detail-page hero.
  cover_cid?: string;
  tag?: string;
  readme?: string;
  moddedFrom?: string;
}

export const VISIBILITY_PRIVATE = 0;
export { VISIBILITY_PUBLIC, TAGS, type AppEntry } from "./registryTypes";
import { VISIBILITY_PUBLIC, TAGS, type AppEntry } from "./registryTypes";

export interface AppDetails {
  metadata?: AppMetadata;
  /** Cumulative permanent stars given to this app. */
  starCount?: number;
  /** Whether the current viewer has permanently starred this app. */
  hasStarred?: boolean;
  /** Number of unique modders who have published a mod of this app. */
  modCount?: number;
}

/// Apps-grid sort key. `newest` paginates `registry.getApps` (reverse-index
/// order, the legacy default); `stars` / `mods` paginate `getTopStarred` /
/// `getTopModded`, each backed by an on-chain OrderedIndex maintained by the
/// star/mod-credit paths. Lazy-backfill caveat applies: v13 indexes
/// start empty and only contain domains touched since the redeploy.
export type AppsSort = "newest" | "stars" | "mods";

/// Maps each sort key to the registry method that returns its page.
const METHOD_BY_SORT: Record<AppsSort, "getApps" | "getTopStarred" | "getTopModded"> = {
  newest: "getApps",
  stars: "getTopStarred",
  mods: "getTopModded",
};

// XP confetti tuning. The pop auto-dismisses after a few seconds since it can
// arrive unprompted (someone stars/mods your app mid-browse); the cooldown
// collapses a burst of awards into one celebration.
const CELEBRATION_AUTO_DISMISS_MS = 5000;
const CELEBRATION_COOLDOWN_MS = 5000;

// ---------------------------------------------------------------------------
// Become-a-builder route — the CLI hand-off. A user who started in the terminal
// but isn't a builder yet is sent to `/become-builder`; on arrival we auto-open
// the one-approval flow over the Playground tab (the modal itself is rendered
// globally by the OnboardingProvider). The route shows the Playground tab
// underneath, with the modal overlaid on top. Already a builder → nothing to
// run, so send them straight to the Playground tab at `/`.
// ---------------------------------------------------------------------------

function BecomeBuilderRoute({
  account,
  pointsRefresh,
}: {
  account?: string;
  pointsRefresh: number;
}) {
  const { account: connected, hasIdentity, identityResolved, startBecomeBuilder } =
    useOnboarding();
  const fired = useRef(false);

  // Once connected and confirmed NOT a builder, open the flow exactly once. Wait
  // for `identityResolved` first: `hasIdentity` is `false` while the read is
  // still in flight, so firing on it would (a) silently start a faucet top-up
  // for an already-builder and (b) pop the become-builder modal at them before
  // the redirect below lands — and that modal, rendered globally by the
  // provider, would stay overlaid after this route unmounts.
  useEffect(() => {
    if (connected && identityResolved && !hasIdentity && !fired.current) {
      fired.current = true;
      startBecomeBuilder();
    }
  }, [connected, identityResolved, hasIdentity, startBecomeBuilder]);

  // Already a builder → no flow to run; take them to the Playground tab.
  if (connected && hasIdentity) {
    return <Navigate to="/" replace />;
  }

  return <PlaygroundTab account={account} pointsRefresh={pointsRefresh} />;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [entries, setEntries] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // True when the load error was a connection timeout (DeadlineError). In the
  // host an in-app retry just re-awaits the same wedged client and reload() is
  // a no-op, so the only real fix is a manual reload — we hide the Retry button
  // in that case rather than offer a button that can't work.
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // Set once the first load has run long enough to suggest a reload (see the
  // effect below). Purely cosmetic — it never touches the in-flight load,
  // which self-heals if the data eventually arrives.
  const [loadStalled, setLoadStalled] = useState(false);
  // Apps-grid sort. Lives in App.tsx (not AppsTab) because it changes the
  // backing read call: paginated `getApps` for newest, `getTopStarred` /
  // `getTopModded` for the on-chain sorted indexes. `fetchPage` reads
  // `sortByRef` so existing callbacks (loadMore, retryLoad) don't churn deps.
  const [sortBy, setSortBy] = useState<AppsSort>("newest");
  const sortByRef = useRef<AppsSort>("newest");
  const signer = useSignerState();

  // Reads use the dedicated dry-run origin (no signerManager on the
  // ContractManager), so the grid loads without a signer prompt. `runTx`
  // calls `ensureSignerReady` lazily before each write, which is when the
  // host prompts the user to connect + grant the SmartContractAllowance.
  const [detailEntry, setModEntry] = useState<AppEntry | null>(null);
  // Bumped on events that concern the CURRENT user (see the subscription
  // below) so their surfaces re-fetch without polling.
  const [pointsRefresh, setPointsRefresh] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pinnedEntries, setPinnedEntries] = useState<AppEntry[]>([]);
  const [pinnedDomains, setPinnedDomains] = useState<Set<string>>(new Set());

  const loadedRef = useRef(0);
  const totalRef = useRef(-1);
  const busyRef = useRef(false);
  // Mirror the current user's address into a ref so the event subscription
  // (set up once on mount) can read the latest value without re-subscribing.
  const currentUserRef = useRef<string | undefined>(signer.selectedAccount?.h160Address);
  useEffect(() => {
    currentUserRef.current = signer.selectedAccount?.h160Address;
  }, [signer.selectedAccount?.h160Address]);

  // Revalidate the connected user's per-account surfaces when the tab regains
  // focus / becomes visible again. These (island XP + quests, points breakdown,
  // identity-derived display name + the "Become a builder" button) are read
  // once on mount and otherwise refreshed only by same-tab events for this
  // user — so a change made on ANOTHER device, or while this tab sat
  // backgrounded, would stay stale until a manual reload. Bumping pointsRefresh
  // re-reads the XP/quest/breakdown surfaces; revalidateRootIdentities re-reads
  // every mounted identity hook (display name + button visibility). No polling:
  // we reconcile only at the moment the user looks back at the tab.
  useEffect(() => {
    const revalidate = () => {
      if (!currentUserRef.current) return;
      setPointsRefresh((k) => k + 1);
      revalidateRootIdentities();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // XP confetti: fired whenever an award event credits the connected user (see
  // the registry-event subscription below).
  const [celebration, setCelebration] = useState<XpCelebrationSpec | null>(null);
  const lastCelebrationAtRef = useRef(0);

  // Next apps page fetch. Social row data is hydrated separately through
  // `getAppData` so the pagination read stays focused on ordering.
  const prefetchRef = useRef<Promise<{ entries: AppEntry[]; scanned: number }> | null>(null);
  const detailsRef = useRef<Map<string, AppDetails>>(new Map());
  // Wired by the Leaderboard component on mount — calling this triggers a
  // re-fetch of get_top_builders. Stays as undefined when the leaderboard
  // surface isn't mounted, so the registry-event dispatch is a no-op then.
  const leaderboardVersionRef = useRef<(() => void) | undefined>(undefined);
  const [detailsVersion, setDetailsVersion] = useState(0);
  // Coalesce detailsRef mutations into one render per animation frame: many
  // metadata/metrics fetches can resolve close together, but we only need to
  // re-render at most once per frame.
  const flushScheduled = useRef(false);
  const scheduleDetailsFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    requestAnimationFrame(() => {
      flushScheduled.current = false;
      setDetailsVersion(v => v + 1);
      if (journeyTracker.isActive("page-load")) {
        journeyTracker.milestone("page-load", "metadata-rendered");
        journeyTracker.complete("page-load");
      }
    });
  }, []);

  // Fetch a page and return parsed entries + scanned slot count for correct
  // offset advancement. Branches on the current sort (read from a ref so the
  // callback identity stays stable across sort changes — pagination state is
  // reset by an effect, not by fetchPage's identity).
  const fetchPage = useCallback(async (offset: number): Promise<{ entries: AppEntry[]; scanned: number }> => {
    const sort = sortByRef.current;
    const method = METHOD_BY_SORT[sort];
    const spanName = `registry.${method}`;
    return Sentry.startSpan(
      { name: spanName, op: SpanOp.CHAIN_QUERY, attributes: { offset, page_size: PAGE, sort } },
      async (span) => {
        const registry = await registryReady;
        // Deadline the read itself: even past a healthy connect, a single
        // query can hang on a wedged host bridge. Without this the load never
        // settles, `loading` stays true and the grid is stuck on skeletons
        // forever (see deadline.ts). A DeadlineError lands in loadMore's catch.
        const r = await withDeadline<any>(
          (registry as any)[method].query(offset, PAGE),
          READ_DEADLINE_MS,
          "Loading apps",
        );
        if (!r.success) {
          // `r.value` carries the raw dispatch-error payload (e.g.
          // `{ type: "AccountNotMapped" }`, `{ type: "ContractReverted" }`,
          // `{ type: "Module", value: ... }`). The tag is a useful hint in
          // the banner; the full payload goes to the console + Sentry.
          const detail = r.value as { type?: string } | undefined;
          const tag = typeof detail?.type === "string" ? detail.type : null;
          console.error(
            `[playground] ${spanName}(${offset}, ${PAGE}) returned success=false: ${stringify(r)}`,
          );
          span.setStatus({ code: 2, message: tag ? `query-failed:${tag}` : "query-not-success" });
          throw new Error(
            tag
              ? `Couldn't reach the registry contract (${tag}). Please try again.`
              : "Couldn't reach the registry contract. Please try again.",
          );
        }
        if (r.value == null || typeof r.value !== "object" || !("total" in r.value)) {
          // eth_call returned ok with empty bytes (or a non-struct shape) —
          // typical when the registry contract isn't deployed at the resolved
          // address (e.g. cdm.json points at a chain that hasn't been
          // redeployed to). Surface a clearer error than the downstream
          // `Cannot read 'total' of undefined`.
          span.setStatus({ code: 2, message: "registry-empty-response" });
          throw new Error(
            `Registry contract returned an unexpected response (success=${r.success}, valueType=${typeof r.value}). The contract is likely not deployed at the resolved address on the current chain — redeploy contracts and re-run \`cdm install\`, or update cdm.json.`,
          );
        }
        const total = r.value.total;
        if (totalRef.current === -1) totalRef.current = total;
        const entries = (r.value.entries ?? []).map((e: any) => ({
          index: e.index,
          domain: e.domain,
          metadataUri: e.metadata_uri,
          owner: String(e.owner),
          visibility: e.visibility,
          publisher: normalizeAddress(e.publisher),
        }));
        return { entries, scanned: Number(r.value.scanned ?? entries.length) };
      },
    );
  }, []);

  // Backfill metadata + social data into detailsRef map. Contract-side app
  // data is fetched once per visible batch; Bulletin metadata still hydrates by
  // CID and resolves independently.
  const backfillDetails = useCallback((batch: AppEntry[]) => {
    const map = detailsRef.current;

    const hydrateMetadata = (domain: string, metadataUri?: string) => {
      if (!metadataUri || map.get(domain)?.metadata) return;
      fetchMetadata(metadataUri).then(metadata => {
        if (!metadata) return;
        map.set(domain, { ...map.get(domain), metadata });
        scheduleDetailsFlush();
      });
    };

    batch.forEach(entry => hydrateMetadata(entry.domain, entry.metadataUri));

    const voter = currentUserRef.current;
    const domainsNeedingAppData = batch
      .filter(entry => {
        const details = map.get(entry.domain);
        return (
          !entry.metadataUri ||
          details?.starCount === undefined ||
          details?.modCount === undefined ||
          (!!voter && details?.hasStarred === undefined)
        );
      })
      .map(entry => entry.domain);

    if (domainsNeedingAppData.length === 0) return;

    fetchAppDataBatch(domainsNeedingAppData, voter).then(appData => {
      if (!appData) return;
      const sameVoter = currentUserRef.current === voter;
      let changed = false;

      for (const entry of batch) {
        const data = appData.get(entry.domain);
        if (!data) continue;
        hydrateMetadata(entry.domain, data.metadataUri);

        const prev = map.get(entry.domain);
        const next: AppDetails = { ...prev };
        if (next.starCount === undefined) next.starCount = data.starCount;
        if (next.modCount === undefined) next.modCount = data.modCount;
        if (voter && sameVoter && next.hasStarred === undefined) {
          next.hasStarred = data.hasStarred;
        }
        if (
          next.starCount !== prev?.starCount ||
          next.modCount !== prev?.modCount ||
          next.hasStarred !== prev?.hasStarred
        ) {
          map.set(entry.domain, next);
          changed = true;
        }
      }

      if (changed) scheduleDetailsFlush();
    });
  }, [scheduleDetailsFlush]);

  const loadMore = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setLoadError(null);
    setLoadTimedOut(false);
    try {
      const loaded = loadedRef.current;

      // Use prefetched page if available, otherwise fetch now
      const page = prefetchRef.current
        ? await prefetchRef.current
        : await fetchPage(loaded);
      prefetchRef.current = null;

        if (page.entries.length === 0) { setHasMore(false); return; }

      loadedRef.current = loaded + page.scanned;
      const total = totalRef.current;
      setEntries(prev => [...prev, ...page.entries]);
      setHasMore(loaded + page.scanned < total);

      if (loaded === 0) {
        journeyTracker.milestone("page-load", "first-page-loaded");
        journeyTracker.addAttributes("page-load", {
          "page_load.entry_count": page.entries.length,
          "page_load.total_apps": total,
        });
        if (page.entries.length === 0) {
          // No apps to backfill — close the journey now.
          journeyTracker.complete("page-load");
        } else {
          // Watchdog: closes the journey if every metadata fetch stalls (e.g. IPFS down).
          setTimeout(() => {
            if (journeyTracker.isActive("page-load")) {
              journeyTracker.addAttributes("page-load", { "page_load.metadata_stalled": true });
              journeyTracker.complete("page-load");
            }
          }, PAGE_LOAD_WATCHDOG_MS);
        }
      }

      backfillDetails(page.entries);

      // Prefetch the next page in the background
      const nextOffset = loaded + page.scanned;
      if (nextOffset < total) {
        prefetchRef.current = fetchPage(nextOffset).catch(() => ({ entries: [], scanned: 0 }));
      }
    } catch (err) {
      console.error("Load error:", err);
      setHasMore(false);
      // A DeadlineError means the chain connection wedged (hung, not errored).
      // The shared message is deploy-flavoured, and in the host an in-app retry
      // just re-awaits the same dead module-level client — so steer the user to
      // the one recovery that works (a manual page reload) and drop the Retry
      // button via loadTimedOut. Ordinary errors keep Retry — re-running the
      // query against a live connection can recover those.
      const timedOut = err instanceof DeadlineError;
      setLoadTimedOut(timedOut);
      setLoadError(
        timedOut
          ? "Couldn't reach the chain. The connection on this host looks stuck. Please reload the page to try again."
          : err instanceof Error
            ? err.message
            : String(err),
      );
      if (journeyTracker.isActive("page-load")) {
        journeyTracker.fail("page-load", "load-page-failed", err);
      }
      Sentry.captureException(err, { tags: { phase: "load-more" } });
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [fetchPage, backfillDetails]);

  // "Slow load" hint — same shape as BuilderApp's liveState deadline machine
  // (cancellation-safe effect). Armed only while the FIRST page is still in
  // flight (loading + nothing rendered yet); torn down the instant the load
  // settles — data arrives, the catch fires, or the READ_DEADLINE_MS backstop
  // rejects — so a healthy load never flashes a hint. Cosmetic: it doesn't
  // abort the load, so a merely-slow connection self-heals when the read lands.
  useEffect(() => {
    if (!(loading && entries.length === 0)) {
      setLoadStalled(false);
      return;
    }
    const t = setTimeout(() => setLoadStalled(true), APPS_LOAD_RELOAD_HINT_MS);
    return () => clearTimeout(t);
  }, [loading, entries.length]);

  const removeDomain = useCallback((domain: string) => {
    setEntries(prev => removeEntry(prev, domain));
    setPinnedEntries(prev => removeEntry(prev, domain));
    setPinnedDomains(prev => { const next = new Set(prev); next.delete(domain); return next; });
  }, []);

  const refreshSocialCounts = useCallback((domain: string) => {
    const voter = currentUserRef.current;
    fetchAppData(domain, voter).then(data => {
      const map = detailsRef.current;
      const prev = map.get(domain);
      if (data) {
        map.set(domain, {
          ...prev,
          starCount: data.starCount,
          modCount: data.modCount,
          ...(voter ? { hasStarred: data.hasStarred } : {}),
        });
      } else if (prev) {
        map.set(domain, { ...prev, starCount: undefined, modCount: undefined });
      }
      setDetailsVersion(v => v + 1);
    });
  }, []);

  // Account switch invalidates every cached `hasStarred` flag — it was fetched
  // for the previous account. Wipe it and, when connected, refresh every
  // cached domain in one batch so grid cards reflect the new account's star
  // state. New page loads use `backfillDetails`, which reads the same
  // `currentUserRef`.
  useEffect(() => {
    const voter = signer.selectedAccount?.h160Address;
    const map = detailsRef.current;
    if (map.size === 0) return;
    const domains = Array.from(map.keys());
    let wiped = false;
    for (const [domain, prev] of map) {
      if (prev.hasStarred === undefined) continue;
      map.set(domain, { ...prev, hasStarred: undefined });
      wiped = true;
    }
    if (wiped) scheduleDetailsFlush();
    if (!voter) return;

    fetchAppDataBatch(domains, voter).then(appData => {
      if (!appData || currentUserRef.current !== voter) return;
      let changed = false;
      for (const domain of domains) {
        const data = appData.get(domain);
        if (!data) continue;
        map.set(domain, { ...map.get(domain), hasStarred: data.hasStarred });
        changed = true;
      }
      if (changed) scheduleDetailsFlush();
    });
  }, [signer.selectedAccount?.h160Address, scheduleDetailsFlush]);

  const handleSelectEntry = useCallback((entry: AppEntry) => {
    addUiBreadcrumb("Open app detail", { domain: entry.domain });
    setAppInUrl(entry.domain);
    setModEntry(entry);
  }, []);
  const handleSelectByDomain = useCallback(async (domain: string): Promise<boolean> => {
    const entry = await fetchAppEntry(domain);
    if (!entry) return false;
    backfillDetails([entry]);
    handleSelectEntry(entry);
    return true;
  }, [backfillDetails, handleSelectEntry]);
  const handleCloseDetail = useCallback(() => {
    setModEntry(null);
    setAppInUrl(null);
  }, []);

  // Close the detail pane on Escape. Listener is only attached while the
  // pane is open, so it doesn't compete with other Escape handlers (modals,
  // browser controls) when nothing is open.
  useEffect(() => {
    if (!detailEntry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCloseDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailEntry, handleCloseDetail]);

  // Initial deep link: open the panel for ?app=<domain> on first mount.
  const initialDeepLinkRef = useRef(false);
  useEffect(() => {
    if (initialDeepLinkRef.current) return;
    initialDeepLinkRef.current = true;
    const domain = getAppFromUrl();
    if (!domain) return;
    fetchAppEntry(domain).then(entry => {
      if (!entry) return;
      if (getAppFromUrl() !== domain) return;
      backfillDetails([entry]);
      setModEntry(entry);
    });
  }, [backfillDetails]);

  // best-block waitFor for the interactive star action: the count refreshes
  // the moment the tx is included, without the finalization wait. Self-
  // corrects on revert via the post-tx refreshSocialCounts re-read.
  const handleStar = useCallback(async (domain: string) => {
    const registry = await registryReady;
    try {
      await guardedWrite(() =>
        runTx(
          "star",
          (opts) => registry.star.tx(domain, opts),
          { domain },
          { waitFor: "best-block" },
        ),
      );
    } catch (err) {
      // Real failures here are otherwise invisible: handleCardStar swallows
      // and the direct onStar path has no catch. Capture non-cancellations so
      // they group with the other call-site captures (delete / pin / publish).
      if (!isSigningRejection(err) && !isInsufficientFundsError(err) && !isNotABuilderError(err)) {
        Sentry.captureException(err, { tags: { action: "star", domain } });
      }
      throw err;
    }
    refreshSocialCounts(domain);
  }, [refreshSocialCounts]);

  // AppCard's onClick has no surrounding catch; swallow here to suppress
  // `onunhandledrejection`. `runTx` already logs the failure to the console.
  const handleCardStar = useCallback(async (domain: string) => {
    try {
      await handleStar(domain);
    } catch {
      // intentionally empty
    }
  }, [handleStar]);

  const handleSetVisibility = useCallback(async (domain: string, vis: number) => {
    // setVisibility gates on `is_authorized(caller())` (owner OR sudo/admin).
    // See handleTogglePin for the dry-run-origin rationale.
    const origin = signer.selectedAccount?.address;
    return runVisibilityToggle(
      domain,
      vis,
      {
        setVisibility: async (d, v) => {
          const registry = await registryReady;
          return guardedWrite(() =>
            runTx(
              "setVisibility",
              (opts) => registry.setVisibility.tx(d, v, { ...opts, origin }) as Promise<{ ok: boolean }>,
              { domain: d, visibility: v },
            ),
          );
        },
        fetchEntry: fetchAppEntry,
      },
      {
        breadcrumb: (opts) => addUserActionBreadcrumb("Toggle visibility", opts),
        removeDomain,
        prependEntry: (entry) =>
          setEntries((prev) => [entry, ...removeEntry(prev, entry.domain)]),
        backfillDetails,
        patchModEntry: (d, v) =>
          setModEntry((prev) =>
            prev && prev.domain === d ? { ...prev, visibility: v } : prev,
          ),
        isSigningRejection,
        captureException: (err, tags) => Sentry.captureException(err, { tags }),
      },
    );
  }, [removeDomain, backfillDetails, signer.selectedAccount?.address]);

  // Upload a new cover image and re-publish the app's metadata pointing at it.
  // Re-publish preserves owner + publisher on the contract (only visibility
  // and metadata_uri are mutable after first publish), so passing the current
  // visibility keeps the rest of the entry intact.
  const handleUpdateCoverImage = useCallback(async (domain: string, bytes: Uint8Array) => {
    addUserActionBreadcrumb("Edit cover image", { domain });
    // Provision the SmartContractAllowance up front for the re-publish below
    // (the registry write needs it; runTx would also do it, idempotently).
    // The Bulletin uploads go through the host preimage path (storeBytesViaHost),
    // which requests its own PreimageSubmit permission — they do NOT depend on
    // ensureSignerReady / BulletinAllowance.
    await ensureSignerReady();
    const registry = await registryReady;

    // Read the existing metadata so we preserve every other field — the
    // editor only mutates `cover_cid`. The detailsRef cache has it for any
    // currently-visible app; falling back to a fresh fetch keeps the path
    // correct if it isn't cached yet.
    let metadata: AppMetadata = detailsRef.current.get(domain)?.metadata ?? {};
    if (!metadata.name) {
      const entry = await fetchAppEntry(domain);
      if (entry?.metadataUri) {
        metadata = (await fetchMetadata(entry.metadataUri)) ?? metadata;
      }
    }

    const coverCidObj = await calculateCid(bytes);
    const coverCid = coverCidObj.toString();
    const nextMetadata: AppMetadata = { ...metadata, cover_cid: coverCid };
    const metadataBytes = new TextEncoder().encode(JSON.stringify(nextMetadata));
    const metadataCidObj = await calculateCid(metadataBytes);
    const metadataCid = metadataCidObj.toString();

    // Upload the cover bytes then the metadata blob. Sequential so the
    // metadata it points to is durably stored before we publish a CID that
    // references it.
    await Sentry.startSpan(
      { name: "bulletin.upload", op: SpanOp.BULLETIN_UPLOAD, attributes: { item_count: 2 } },
      async () => {
        await storeBytesViaHost(bytes);
        await storeBytesViaHost(metadataBytes);
      },
    );

    // Re-publish: owner = None (defaults to caller; ignored on re-publish),
    // modded_from = "" (re-publish ignores it), is_moddable preserves the
    // repository signal, is_dev_signer = false (always false in the UI path).
    const currentEntry = detailEntry?.domain === domain
      ? detailEntry
      : entries.find(e => e.domain === domain)
        ?? pinnedEntries.find(e => e.domain === domain);
    const visibility = currentEntry?.visibility ?? VISIBILITY_PUBLIC;
    const isModdable = !!nextMetadata.repository?.trim();
    await guardedWrite(() =>
      runTx(
        "publish",
        (opts) =>
          registry.publish.tx(
            domain,
            metadataCid,
            visibility,
            { isSome: false, value: "0x0000000000000000000000000000000000000000" as const },
            "",
            isModdable,
            false,
            opts,
          ) as Promise<{ ok: boolean }>,
        { domain, action: "edit-cover" },
      ),
    );

    // Patch the cached metadata so the detail panel re-renders with the new
    // cover immediately, without waiting for the chain event round-trip.
    const prev = detailsRef.current.get(domain) ?? {};
    detailsRef.current.set(domain, { ...prev, metadata: nextMetadata });
    setDetailsVersion(v => v + 1);
    // Mirror the new metadataUri onto the entry list / detail entry so a page
    // refresh keeps showing the new cover.
    setEntries(prev =>
      prev.map(e => (e.domain === domain ? { ...e, metadataUri: metadataCid } : e)),
    );
    setModEntry(prev =>
      prev && prev.domain === domain ? { ...prev, metadataUri: metadataCid } : prev,
    );
  }, [detailEntry, entries, pinnedEntries]);

  const fetchPinnedApps = useCallback(async () => {
    try {
      const registry = await registryReady;
      const r = await withReadDeadline(registry.getPinnedApps.query(), "Registry pinned apps");
      if (!r.success) return;
      const apps: AppEntry[] = (r.value ?? []).map((e: any) => ({
        index: e.index,
        domain: e.domain,
        metadataUri: e.metadata_uri,
        owner: String(e.owner),
        pinned: true,
        visibility: e.visibility,
        publisher: normalizeAddress(e.publisher),
      }));
      setPinnedEntries(apps);
      setPinnedDomains(new Set(apps.map(a => a.domain)));
      backfillDetails(apps);
    } catch (err) {
      console.error("Failed to fetch pinned apps:", err);
    }
  }, [backfillDetails]);

  const handleTogglePin = useCallback(async (domain: string, pin: boolean) => {
    addAdminActionBreadcrumb(pin ? "Pin app" : "Unpin app", { domain });
    try {
      const registry = await registryReady;
      // pin/unpin gate on `is_sudo_or_admin(caller())` — and the SDK's dry-run
      // origin otherwise defaults to `defaultOrigin` (the //playground-querier
      // read origin set in contracts.ts) because no `signerManager` is wired
      // into ContractManager. Without this explicit override the dry-run runs
      // as the querier, fails the admin check, and the tx is never submitted
      // even though the signed caller IS in the admin set. Pass the connected
      // SS58 so the dry-run runs as the real caller.
      const origin = signer.selectedAccount?.address;
      await guardedWrite(() =>
        runTx(
          pin ? "pin" : "unpin",
          (opts) => (pin
            ? registry.pin.tx(domain, { ...opts, origin })
            : registry.unpin.tx(domain, { ...opts, origin })),
          { domain },
        ),
      );
      await fetchPinnedApps();
    } catch (err) {
      if (isSigningRejection(err) || isInsufficientFundsError(err) || isNotABuilderError(err)) return;
      Sentry.captureException(err, { tags: { action: pin ? "pin" : "unpin", domain } });
      throw err;
    }
  }, [fetchPinnedApps, signer.selectedAccount?.address]);

  // Pinned apps are global — fetch once on mount.
  useEffect(() => { fetchPinnedApps(); }, [fetchPinnedApps]);

  // Load apps and check admin status. Re-runs when account changes so
  // get_apps uses the new caller (shows owner's private apps).
  const accountRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const addr = signer.selectedAccount?.h160Address;

    // Check admin status
    if (!addr) { setIsAdmin(false); } else {
      checkIsAdmin(addr).then(setIsAdmin);
    }

    // On account change (not initial mount), reset before refetching
    if (accountRef.current !== undefined && accountRef.current !== addr) {
      loadedRef.current = 0;
      totalRef.current = -1;
      prefetchRef.current = null;
      busyRef.current = false;
      setEntries([]);
      setHasMore(true);
    }
    accountRef.current = addr;

    loadMore();
  }, [signer.selectedAccount?.h160Address, loadMore]);

  // Subscribe to contract events for live updates
  useEffect(() => {
    return playgroundEventStream.subscribeItems((item) => {
      if (!isRegistryEventStreamItem(item) || !item.payload) return;
      const event = item.payload;
      // pointsRefresh drives the CURRENT user's surfaces (island XP, task
      // checks, own profile panel) — bump it only for their own point events
      // plus the events that can't say whose they are (Published could be
      // their own CLI deploy). Identity events DO carry the recipient
      // (primaryAccount), so the `me`-match below already covers them. A
      // stranger's award must not re-trigger our per-account reads.
      const me = currentUserRef.current?.toLowerCase();
      const concernsUser =
        (!!me && event.primaryAccount?.toLowerCase() === me) ||
        event.name === "Published";
      if (concernsUser) setPointsRefresh((k) => k + 1);
      // XP confetti for the connected user's own awards. Gate on the award's
      // recipient (primaryAccount), not the broader `concernsUser` flag, so a
      // stranger's deploy / a username broadcast never pops. The cooldown drops
      // back-to-back awards (a flurry of stars) to a single celebration.
      if (me && event.primaryAccount?.toLowerCase() === me) {
        // The intro bonus (becoming a builder) is once-ever — record it locally
        // so the "Introduce yourself" achievement marks complete when the award
        // lands here (e.g. claimed on the phone, observed live on this desktop
        // tab).
        if (event.name === "IdentityBonusAwarded") {
          markIdentityBonusClaimed(me);
        }
        const spec = celebrationForEvent(event);
        if (spec) {
          const now = Date.now();
          if (now - lastCelebrationAtRef.current >= CELEBRATION_COOLDOWN_MS) {
            lastCelebrationAtRef.current = now;
            setCelebration(spec);
          }
        }
      }
      handleRegistryEvent(event.name, event.primaryDomain ?? "", {
        fetchEntry: fetchAppEntry,
        applyDecision: (entry, decision) => {
          if (decision === "remove") {
            removeDomain(entry.domain);
          } else if (sortByRef.current === "newest") {
            setEntries((prev) => upsertEntry(prev, entry));
          }
          // For sorted views (stars/mods) a fresh publish has count 0 and
          // isn't in the on-chain index. The user gets it on next sort
          // switch or scroll-refresh; injecting at index 0 would mis-rank it.
        },
        removeDomain,
        fetchPinnedApps,
        backfillDetails,
        getCurrentUserAddr: () => currentUserRef.current,
        refreshSocialCounts,
        refreshLeaderboard: () => leaderboardVersionRef.current?.(),
        refreshIdentities: revalidateRootIdentities,
      });
    });
  }, [backfillDetails, fetchPinnedApps, removeDomain, refreshSocialCounts]);

  const retryLoad = useCallback(() => {
    loadedRef.current = 0;
    totalRef.current = -1;
    prefetchRef.current = null;
    busyRef.current = false;
    setEntries([]);
    setHasMore(true);
    loadMore();
  }, [loadMore]);

  // Sort-change reset: wipe pagination state (offset, total, prefetched
  // page, current entries) and trigger a fresh load against the new sort's
  // backing read method. Skips the initial mount (where the load is driven
  // by the account-change effect above). The ref mirror lets fetchPage
  // observe the chosen sort without re-creating loadMore.
  const handleSortChange = useCallback((next: AppsSort) => {
    if (sortByRef.current === next) return;
    sortByRef.current = next;
    setSortBy(next);
    loadedRef.current = 0;
    totalRef.current = -1;
    prefetchRef.current = null;
    busyRef.current = false;
    setEntries([]);
    setHasMore(true);
    setLoadError(null);
    loadMore();
  }, [loadMore]);

  return (
    <>
      <div className="grain-bg"><GrainCanvas /></div>
      {celebration && (
        <XpCelebration
          xp={celebration.xp}
          label={celebration.label}
          autoDismissMs={CELEBRATION_AUTO_DISMISS_MS}
          onDone={() => setCelebration(null)}
        />
      )}
      <EventStream />
      <OnboardingProvider refreshKey={pointsRefresh}>
      <div className="app-shell">
        <LeftRail />
        <main className="app-main">
          <Routes>
            <Route
              path="/"
              element={
                <PlaygroundTab
                  account={signer.selectedAccount?.h160Address}
                  pointsRefresh={pointsRefresh}
                />
              }
            />
            <Route path="/about" element={<AboutTab />} />
            <Route
              path="/apps"
              element={
                <AppsTab
                  entries={entries}
                  pinnedEntries={pinnedEntries}
                  pinnedDomains={pinnedDomains}
                  loading={loading}
                  loadStalled={loadStalled}
                  loadError={loadError}
                  loadTimedOut={loadTimedOut}
                  hasMore={hasMore}
                  detailsRef={detailsRef}
                  detailsVersion={detailsVersion}
                  loadMore={loadMore}
                  handleSelectEntry={handleSelectEntry}
                  retryLoad={retryLoad}
                  reviewer={signer.selectedAccount?.h160Address}
                  onStar={handleCardStar}
                  sortBy={sortBy}
                  onSortChange={handleSortChange}
                />
              }
            />
            <Route
              path="/profile"
              element={
                <ProfileTab
                  signer={signer}
                  isAdmin={isAdmin}
                  onMod={handleSelectEntry}
                  pointsRefresh={pointsRefresh}
                  onStar={handleCardStar}
                />
              }
            />
            <Route
              path="/profile/:profileId"
              element={
                <PublicProfilePage
                  signer={signer}
                  isAdmin={isAdmin}
                  onMod={handleSelectEntry}
                  pointsRefresh={pointsRefresh}
                  onStar={handleCardStar}
                  onOpenApp={handleSelectByDomain}
                />
              }
            />
            <Route
              path="/builder"
              element={
                <SectionBoundary name="builder">
                  <Suspense fallback={<LoadingFallback />}>
                    <BuilderTab />
                  </Suspense>
                </SectionBoundary>
              }
            />
            <Route
              path="/leaderboard"
              element={
                <SectionBoundary name="leaderboard">
                  <Leaderboard
                    currentUserAddr={signer.selectedAccount?.h160Address}
                    registerRefresh={(refresh) => {
                      leaderboardVersionRef.current = refresh;
                    }}
                  />
                </SectionBoundary>
              }
            />
            <Route
              path="/become-builder"
              element={
                <BecomeBuilderRoute
                  account={signer.selectedAccount?.h160Address}
                  pointsRefresh={pointsRefresh}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {detailEntry && (
        <SectionBoundary name="app-detail">
          <AppDetailPanel
            entry={detailEntry}
            details={detailsRef.current.get(detailEntry.domain)}
            signer={signer}
            isAdmin={isAdmin}
            isPinned={pinnedDomains.has(detailEntry.domain)}
            fetchHasStarred={fetchHasStarred}
            onClose={handleCloseDetail}
            onStar={handleStar}
            onTogglePin={handleTogglePin}
            onSetVisibility={handleSetVisibility}
            onSelectApp={handleSelectByDomain}
            onUpdateCoverImage={handleUpdateCoverImage}
          />
        </SectionBoundary>
      )}
      </OnboardingProvider>
    </>
  );
}

// ---------------------------------------------------------------------------
// Public profile
// ---------------------------------------------------------------------------

function PublicProfilePage({
  signer,
  onMod,
  pointsRefresh,
  isAdmin,
  onStar,
  onOpenApp,
}: {
  signer: SignerState;
  onMod: (e: AppEntry) => void;
  pointsRefresh: number;
  isAdmin: boolean;
  onStar: (domain: string) => Promise<void>;
  /** Re-open an app's detail panel — used by the "back to app" button when the
   *  visitor arrived here from an App Detail Page author link. */
  onOpenApp: (domain: string) => Promise<boolean>;
}) {
  const { profileId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  // Set by the App Detail Page author link so we can offer a way back to it.
  const fromApp = (location.state as { fromApp?: string } | null)?.fromApp;
  // Land on the Apps grid, then open the app's detail over it — so closing the
  // panel leaves the visitor on /apps (a real "back" feel), not this profile.
  const goBackToApp = (domain: string) => {
    navigate("/apps");
    void onOpenApp(domain);
  };
  const [resolution, setResolution] = useState<Awaited<ReturnType<typeof resolveProfileIdentifier>>>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResolution(null);
    resolveProfileIdentifier(profileId).then((next) => {
      if (cancelled) return;
      setResolution(next);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [profileId]);

  if (loading) {
    return (
      <div className="tab tab-profile public-profile" data-testid="public-profile-page">
        <div className="public-profile-state" data-testid="public-profile-loading">
          Loading profile...
        </div>
      </div>
    );
  }

  if (!resolution) {
    const missingProfile = isH160Address(profileId)
      ? "that profile"
      : profileId
        ? `"${profileId}"`
        : "that profile";
    return (
      <div className="tab tab-profile public-profile" data-testid="public-profile-page">
        <section className="public-profile-state" data-testid="public-profile-not-found">
          <h1>Profile not found</h1>
          <p>No builder matches {missingProfile}.</p>
          <Link className="back-to-top-btn profile-back-btn" to="/leaderboard">
            <ArrowLeft size={15} strokeWidth={2.5} />
            Leaderboard
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="tab tab-profile public-profile" data-testid="public-profile-page">
      <section data-testid="public-profile-header">
        {fromApp ? (
          <button
            type="button"
            className="back-to-top-btn profile-back-btn"
            onClick={() => goBackToApp(fromApp)}
            data-testid="profile-back-app"
          >
            <ArrowLeft size={15} strokeWidth={2.5} />
            {fromApp.replace(/\.dot$/, "")}
          </button>
        ) : (
          <Link
            className="back-to-top-btn profile-back-btn"
            to="/leaderboard"
            data-testid="profile-back-leaderboard"
          >
            <ArrowLeft size={15} strokeWidth={2.5} />
            Leaderboard
          </Link>
        )}
      </section>
      <MyApps
        signer={signer}
        onMod={onMod}
        pointsRefresh={pointsRefresh}
        isAdmin={isAdmin}
        ownerAddress={resolution.address}
        readOnly
        onStar={onStar}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Apps
// ---------------------------------------------------------------------------

export function MyApps({
  signer,
  onMod,
  pointsRefresh,
  isAdmin,
  ownerAddress,
  readOnly,
  onStar,
}: {
  signer: SignerState;
  onMod: (e: AppEntry) => void;
  /** Bumped on every point-award event (username bonus, stars, mods, deploys)
   *  so the XP total re-fetches live without reloading the whole apps grid. */
  pointsRefresh: number;
  isAdmin: boolean;
  ownerAddress?: string;
  readOnly?: boolean;
  /** Star an app — passed through to each AppCard so the connected viewer can
   *  star other builders' apps from their profile (self-star stays disabled). */
  onStar?: (domain: string) => Promise<void>;
}) {
  const [myEntries, setMyEntries] = useState<AppEntry[]>([]);
  const myDetailsRef = useRef<Map<string, AppDetails>>(new Map());
  const [loading, setLoading] = useState(false);
  // #406: a profile-grid read that times out (a wedged host bridge on Android)
  // now throws a DeadlineError into the load `catch` rather than hanging — but
  // left to itself that just paints a bare "No apps published yet." with no way
  // to tell a failed load from a genuinely-empty one and no way to recover. This
  // flag turns the failed-and-empty case into a "couldn't load — Retry" state.
  const [loadError, setLoadError] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped to re-render after an optimistic star patch to myDetailsRef —
  // separate from refreshKey so it doesn't trigger the full reload effect.
  const [cardVersion, setCardVersion] = useState(0);

  const account = signer.selectedAccount;
  const selfAddress = account?.h160Address;
  const targetAddress = ownerAddress ?? selfAddress;
  const isSelf = !ownerAddress;
  // Only other builders' apps are starrable; you can't star your own. When
  // viewing someone else's profile, the connected account is the star voter.
  const starVoter = !isSelf ? selfAddress : undefined;

  // Set/Change identity runs through the shared onboarding flow: the modal and
  // the reveal/clear (set_identity / clear_identity) lifecycle live in
  // OnboardingProvider, which survives this view unmounting mid-tx. Here we only
  // open the flow and read the resolved name for display — the displayed name
  // refreshes via the identity-event broadcast (revalidateRootIdentities) once
  // the tx lands.
  const { startBecomeBuilder } = useOnboarding();

  // `refreshKey` is included so the Retry button (#406) re-fires the name read
  // alongside the grid + XP, not just the grid. The name hook self-heals via
  // its own backoff retry too; this makes the single Retry cover all three.
  const { username: chainUsername } = useRootUsername(
    targetAddress as `0x${string}` | undefined,
    refreshKey,
  );

  // Star wrapper for profile cards. Optimistically marks the card starred and
  // bumps its count the instant the tx is submitted (handleStar already does a
  // best-block submit + self-correcting re-read); a revert flips back on the
  // next reload. Re-renders via cardVersion only — no full refetch.
  const handleProfileStar = useCallback(
    async (domain: string) => {
      if (!onStar) return;
      await onStar(domain);
      const prev = myDetailsRef.current.get(domain);
      if (prev && prev.hasStarred !== true) {
        myDetailsRef.current.set(domain, {
          ...prev,
          hasStarred: true,
          starCount: (prev.starCount ?? 0) + 1,
        });
        setCardVersion((v) => v + 1);
      }
    },
    [onStar],
  );

  // A non-null username string means a verified identity is bound on-chain
  // (revealed); null = anonymous; undefined = still loading. In the identity
  // model anonymous accounts resolve to `null` (never the animal handle), so a
  // non-empty-string check is the reveal test.
  const isRevealed = typeof chainUsername === "string" && chainUsername.length > 0;

  useEffect(() => {
    if (!targetAddress) {
      setMyEntries([]);
      myDetailsRef.current.clear();
      return;
    }
    myDetailsRef.current.clear();

    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const registry = await registryReady;
        const countRes = await withReadDeadline(
          registry.getOwnerAppCount.query(targetAddress),
          "Registry owner app count",
        );
        const total = countRes.success ? Number(countRes.value) : 0;

        const domains: Array<{ index: number; domain: string }> = [];
        for (let i = total - 1; i >= 0; i--) {
          if (cancelled) break;
          const dRes = await withReadDeadline(
            registry.getOwnerDomainAt.query(targetAddress, i),
            "Registry owner domain",
          );
          if (!dRes.success || !dRes.value?.isSome) continue;
          domains.push({ index: i, domain: dRes.value.value });
        }

        const appData = await fetchAppDataBatch(domains.map(row => row.domain), starVoter);
        const batch: AppEntry[] = [];
        for (const row of domains) {
          const data = appData?.get(row.domain);
          if (!data?.metadataUri) continue; // unpublished
          if (readOnly && data.visibility < VISIBILITY_PUBLIC) continue;
          batch.push({
            index: row.index,
            domain: row.domain,
            metadataUri: data.metadataUri,
            owner: data.owner ?? targetAddress,
            visibility: data.visibility,
            publisher: data.publisher,
          });
        }

        if (!cancelled) {
          await Promise.allSettled(batch.map(async entry => {
            const data = appData?.get(entry.domain);
            const metadata = entry.metadataUri ? await fetchMetadata(entry.metadataUri) : null;
            myDetailsRef.current.set(entry.domain, {
              ...myDetailsRef.current.get(entry.domain),
              ...(metadata ? { metadata } : {}),
              ...(data ? { starCount: data.starCount, modCount: data.modCount } : {}),
              ...(starVoter && data ? { hasStarred: data.hasStarred } : {}),
            });
          }));
          setMyEntries(batch);
        }
      } catch (err) {
        // A wedged/timed-out read (DeadlineError) or any other throw lands here.
        // Surface it as a recoverable state instead of a silent empty grid (#406).
        console.error("MyApps load error:", err);
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [targetAddress, starVoter, refreshKey]);

  // Viewing own profile while not connected → connect prompt.
  if (isSelf && !targetAddress) {
    const connecting = signer.status === "connecting";
    return (
      <div className="my-apps-connect" data-testid="my-apps-connect-prompt">
        <h2>My Apps</h2>
        <p className="my-apps-sub">
          {connecting ? "Connecting..." : "Connect your account to see your published apps."}
        </p>
      </div>
    );
  }

  // Pass the raw hook value (undefined = still loading → "…", null = confirmed
  // anonymous → deterministic name). Coercing to null here would flash the
  // generated name on every mount before the read resolves.
  const displayName = displayNameForAccount(chainUsername, targetAddress);
  // The reveal/clear saving state now lives in the shared onboarding modal, so
  // the profile name simply updates when the identity event lands.
  // Blue is reserved for "me"; other builders get a stable per-account hue.
  // Set as a custom property on the page root so the header name and the
  // Total XP value (inside PointsBreakdown) pick up the same color.
  const profileHue = profileHueForAccount(targetAddress, isSelf);

  return (
    <div
      className="tab-center"
      data-testid="my-apps-view"
      style={{ "--profile-hue": profileHue } as CSSProperties}
    >
      <header className="tab-header tab-header--inline">
        <h1 className="tab-title">
          {/* Public profiles greet too — this is the page's single name line. */}
          {isSelf ? "Hello, " : "Meet 👉 "}
          <span
            className="tab-name"
            data-testid="my-apps-account"
          >
            {displayName}
          </span>
        </h1>
        {/* Profile identity CTA: opens the shared "Become a builder" flow (one
            bundled approval — identity + resources). Shown only while not yet a
            builder; becoming one is a one-way step, so the button vanishes once
            revealed. */}
        {isSelf && account && !isRevealed && (
          <button
            className="ucard-cta username-cta"
            onClick={() => startBecomeBuilder()}
            data-testid="set-username-btn"
          >
            Become a builder
          </button>
        )}
      </header>

      {isSelf && isAdmin && !readOnly && (
        <button
          className="btn btn-publish"
          onClick={() => setShowPublish(true)}
          data-testid="publish-app-btn"
        >
          Publish App
        </button>
      )}

      {targetAddress && (
        <PointsBreakdown
          account={targetAddress}
          refreshKey={refreshKey + pointsRefresh}
          hasUsername={isRevealed}
        />
      )}

      {loading ? (
        <div className="spinner" data-testid="my-apps-loading">Loading apps...</div>
      ) : loadError && myEntries.length === 0 ? (
        // #406: a failed/timed-out load with nothing to show. Distinct from the
        // genuinely-empty state below, and recoverable — Retry bumps refreshKey,
        // which re-runs this effect (and the name + XP reads keyed on it).
        <div className="empty" data-testid="my-apps-load-error">
          <p>Couldn’t load this profile. This is usually a temporary connection problem.</p>
          <button
            type="button"
            className="back-to-top-btn"
            onClick={() => setRefreshKey((k) => k + 1)}
            data-testid="my-apps-retry"
          >
            Retry
          </button>
        </div>
      ) : myEntries.length === 0 ? (
        <div className="empty" data-testid="my-apps-empty-state">
          No apps published yet.
        </div>
      ) : (
        <div className="grid" data-testid="my-apps-grid" data-card-version={cardVersion}>
          {myEntries.map(entry => (
            <AppCard
              key={entry.domain}
              entry={entry}
              details={myDetailsRef.current.get(entry.domain)}
              onSelect={onMod}
              reviewer={selfAddress}
              onStar={onStar ? handleProfileStar : undefined}
            />
          ))}
        </div>
      )}

      {showPublish && isSelf && account && (
        <SectionBoundary name="publish-modal">
          <PublishModal
            onClose={() => setShowPublish(false)}
            onPublished={() => { setShowPublish(false); setRefreshKey(k => k + 1); }}
          />
        </SectionBoundary>
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish modal
// ---------------------------------------------------------------------------

function PublishModal({ onClose, onPublished }: {
  onClose: () => void;
  onPublished: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repository, setRepository] = useState("");
  const [tag, setTag] = useState("");
  const [visibility, setVisibility] = useState(VISIBILITY_PUBLIC);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<PublishStatus>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");

  const pickIcon = (f: File | undefined) => {
    if (!f) return;
    setIconFile(f);
    setIconPreview(URL.createObjectURL(f));
    setError("");
  };

  // Parent might unmount the modal mid-flow (e.g. account change, navigation).
  useEffect(() => () => journeyTracker.abandon("publish"), []);

  const canSubmit = domain.trim() && name.trim() && status === "idle";

  const publish = async () => {
    setError("");
    // Read icon if provided — caller responsibility before runPublishFlow.
    let iconBytes: Uint8Array | null = null;
    if (iconFile) {
      setStatusMsg("Reading icon...");
      iconBytes = new Uint8Array(await iconFile.arrayBuffer());
    }

    const registry = await registryReady;

    const outcome = await runPublishFlow(
      {
        domain,
        name,
        description,
        repository,
        tag,
        visibility,
        iconBytes,
      },
      {
        calculateCid,
        storeBytes: (bytes) => storeBytesViaHost(bytes),
        publishToRegistry: (d, cid, vis, moddedFrom, isModdable) =>
          guardedWrite(() =>
            runTx(
              "publish",
              // owner = None → contract defaults to env::caller() (the signed-in user).
              // Owner override belongs to the separate `publish_dev` method; the
              // frontend's scored publish path is always called by the actual user.
              //
              // The frontend publish flow has no UI for "modded from" — that's a
              // CLI-side feature (`dot mod` captures the source domain in
              // `dot.json`). We always pass "" here. `isModdable` flips true
              // whenever the user provided a repository URL, mirroring how the
              // CLI derives it (a public GitHub URL is the moddable signal).
              //
              // `modded_from` is plain `string` on the contract, NOT
              // `Option<String>` — the latter's SolAbi layout is incompatible
              // with viem's tuple encoding (32-byte vs 64-byte head). Empty
              // string is the "no source" sentinel.
              (opts) =>
                registry.publish.tx(
                  d,
                  cid,
                  vis,
                  { isSome: false, value: "0x0000000000000000000000000000000000000000" as const },
                  moddedFrom ?? "",
                  isModdable,
                  // is_dev_signer is retained for ABI compatibility but ignored;
                  // dev-signer deploys use `publish_dev` instead.
                  false,
                  opts,
                ) as Promise<{ ok: boolean }>,
              { domain: d, modded_from: moddedFrom ?? "", is_moddable: isModdable },
            ),
          ),
        startBulletinSpan: (attrs, fn) =>
          Sentry.startSpan(
            {
              name: "bulletin.upload",
              op: SpanOp.BULLETIN_UPLOAD,
              attributes: { item_count: attrs.itemCount },
            },
            fn,
          ),
      },
      {
        status: setStatus,
        message: setStatusMsg,
        errorMessage: setError,
        start: (opts) =>
          journeyTracker.start("publish", {
            "publish.has_icon": opts.hasIcon,
            "publish.visibility": opts.visibility,
            "publish.has_tag": opts.hasTag,
          }),
        milestone: (name) => journeyTracker.milestone("publish", name),
        complete: () => journeyTracker.complete("publish"),
        fail: (reason, err) => {
          journeyTracker.fail("publish", reason, err);
          Sentry.captureException(err, {
            tags: { phase: "publish", failure_reason: reason },
          });
        },
      },
    );

    if (outcome.ok) {
      setTimeout(onPublished, 1200);
    }
  };

  const isWorking = status !== "idle" && status !== "done" && status !== "error";

  const handleClose = () => {
    if (isWorking) return;
    journeyTracker.abandon("publish");
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal publish-modal"
        onClick={e => e.stopPropagation()}
        data-testid="publish-modal"
        data-status={status}
      >
        <h2>Publish an App</h2>

        {(status === "idle" || status === "error") ? (
          <>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Domain</label>
                <div className="form-domain-wrap">
                  <input
                    className="form-input"
                    placeholder="my-app"
                    value={domain}
                    onChange={e => setDomain(e.target.value)}
                    data-testid="field-domain"
                  />
                  <span className="form-domain-suffix">.dot</span>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Tag</label>
                <select
                  className="form-input"
                  value={tag}
                  onChange={e => setTag(e.target.value)}
                  data-testid="field-tag"
                >
                  <option value="">None</option>
                  {TAGS.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Visibility</label>
              <div className="visibility-toggle">
                <button
                  type="button"
                  className={`visibility-option${visibility === VISIBILITY_PUBLIC ? " active" : ""}`}
                  onClick={() => setVisibility(VISIBILITY_PUBLIC)}
                >
                  Public
                </button>
                <button
                  type="button"
                  className={`visibility-option${visibility === VISIBILITY_PRIVATE ? " active" : ""}`}
                  onClick={() => setVisibility(VISIBILITY_PRIVATE)}
                >
                  Private
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Name</label>
              <input
                className="form-input"
                placeholder="My Cool App"
                value={name}
                onChange={e => setName(e.target.value)}
                data-testid="field-name"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-input form-textarea"
                placeholder="A short description of your app..."
                rows={3}
                value={description}
                onChange={e => setDescription(e.target.value)}
                data-testid="field-description"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Repository URL</label>
              <input
                className="form-input"
                placeholder="https://github.com/..."
                value={repository}
                onChange={e => setRepository(e.target.value)}
                data-testid="field-repo-url"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Icon</label>
              <label className="form-icon-upload">
                {iconPreview
                  ? <img src={iconPreview} alt="" className="form-icon-preview" />
                  : <span className="form-icon-placeholder">Choose image</span>
                }
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={e => pickIcon(e.target.files?.[0])}
                  data-testid="field-icon"
                />
              </label>
            </div>

            {error && <ErrorBanner message={error} compact testid="publish-error" />}

            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={handleClose}
                data-testid="publish-cancel-btn"
              >Cancel</button>
              <button
                className="btn btn-publish"
                onClick={publish}
                disabled={!canSubmit}
                data-testid="publish-submit-btn"
              >
                Publish
              </button>
            </div>
          </>
        ) : (
          <div className="publish-progress">
            <p className="publish-status-msg" data-testid="publish-status-msg">{statusMsg}</p>
            {status === "done" && (
              <p className="publish-done" data-testid="publish-success">Published successfully!</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App card
// ---------------------------------------------------------------------------

type AppCardProps = {
  entry: AppEntry;
  details?: AppDetails;
  onSelect: (entry: AppEntry) => void;
  reviewer?: string;
  onStar?: (domain: string) => Promise<void>;
};

export const AppCard = memo(function AppCard({ entry, details, onSelect, reviewer, onStar }: AppCardProps) {
  const name = details?.metadata?.name ?? entry.domain.replace(/\.dot$/, "");
  // Prefer the explicit description; otherwise derive a blurb from the README
  // (skipping its title / "readme" heading / badge lines). Empty when neither
  // exists — no generic filler.
  const desc =
    details?.metadata?.description?.trim() ||
    readmeBlurb(details?.metadata?.readme) ||
    "";
  const tag = displayTag(details?.metadata?.tag);
  const moddable = !!details?.metadata?.repository;
  const iconUrl = useIconUrl(details?.metadata?.icon_cid);
  const starCount = details?.starCount ?? 0;
  const modCount = details?.modCount ?? 0;
  const hasStarred = details?.hasStarred === true;

  // Small random tilt for the "Featured sample" sticker, rolled once per mount
  // so it stays put across re-renders (mirrors XpLabel's hand-stuck-sticker feel).
  const [featuredRot] = useState(() => Math.random() * 10 - 5);
  const [modOpen, setModOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [lockedHintOpen, setLockedHintOpen] = useState(false);
  const modAnchorRef = useRef<HTMLButtonElement | null>(null);
  const favWrapRef = useRef<HTMLSpanElement | null>(null);

  // Starring writes on-chain, so it needs a builder. Until the viewer is one
  // the star tap opens the "become a builder" nudge instead of attempting a tx.
  // (A builder who's merely out of allowance is handled by guardedWrite, which
  // faucets then stars — no nudge needed there.)
  const { hasIdentity, account: onboardingAccount } = useOnboarding();

  // Stars are one-way. `hasStarred` from the contract disables the button after
  // the viewer's first successful star.
  const isFav = hasStarred;
  // The contract reverts SelfStarForbidden when an owner tries to star their
  // own app — disable the button so the click never reaches the chain.
  const isOwner = !!reviewer && !!entry.owner && entry.owner.toLowerCase() === reviewer.toLowerCase();
  const handleFav = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onStar || !reviewer || favBusy || isOwner || isFav) return;
    // Gate on identity: a connected non-builder gets the gentle nudge anchored
    // to the star, not a doomed transaction.
    if (onboardingAccount && !hasIdentity) {
      setLockedHintOpen(true);
      return;
    }
    setFavBusy(true);
    void onStar(entry.domain)
      .catch(() => undefined)
      .finally(() => setFavBusy(false));
  };

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(buildAppShareUrl(entry.domain));
    addUserActionBreadcrumb("Share app", { domain: entry.domain });
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1400);
  };

  const handleMod = (e: React.MouseEvent) => {
    e.stopPropagation();
    setModOpen(o => !o);
  };

  return (
    <article
      className="app-post"
      style={{ "--card-color": cardColorForDomain(entry.domain) } as CSSProperties}
      onClick={() => onSelect(entry)}
      data-testid="app-card"
      data-domain={entry.domain}
      data-metadata-loaded={details?.metadata ? "true" : "false"}
      data-tag={tag ?? ""}
      data-moddable={moddable ? "true" : "false"}
      data-pinned={entry.pinned ? "true" : "false"}
    >
      <header className="app-post-head">
        <h2 className="app-post-title" data-testid="card-name">
          {entry.pinned && (
            <span className="app-post-pin" aria-label="Pinned" title="Pinned">
              <PinIcon width="20" height="20" />
            </span>
          )}
          <span className="app-post-title-text">
            <span className="app-post-title-clamp">{name}</span>
          </span>
        </h2>
        <LaunchButton domain={entry.domain} />
      </header>
      <p className="app-post-blurb" data-testid="card-desc">{desc}</p>
      <div className="app-post-tags">
        {tag && (
          <span className="filter-pill is-filled" data-tag={tag} data-testid="card-tag">{tag}</span>
        )}
        {moddable && (
          <span className="filter-pill is-filled" data-tag="moddable" data-testid="card-moddable-chip">Moddable</span>
        )}
        {entry.visibility === VISIBILITY_PRIVATE && (
          <span className="filter-pill is-filled" data-tag="private">Private</span>
        )}
        {modCount > 0 && (
          <span
            className="filter-pill is-filled"
            data-tag="modcount"
            data-testid="card-modcount"
            title={`${modCount} modder${modCount === 1 ? "" : "s"}`}
          >
            {modCount}× modded
          </span>
        )}
      </div>
      <div className="app-post-image">
        {entry.pinned && (
          <span
            className="app-post-featured"
            style={{ transform: `rotate(${featuredRot}deg)` }}
            data-testid="card-featured"
          >
            Featured sample
            <PinIcon className="app-post-featured-pin" aria-hidden="true" />
          </span>
        )}
        {iconUrl && <img src={iconUrl} alt="" loading="lazy" draggable={false} />}
      </div>
      <div className="app-post-bar">
        <span
          className="bar-btn-fav-wrap"
          ref={favWrapRef}
          style={{ "--journey-hue": QUEST_COLORS.character } as CSSProperties}
        >
          <button
            type="button"
            className={`bar-btn bar-btn-fav${isFav ? " is-active" : ""}`}
            disabled={!onStar || !reviewer || favBusy || isOwner || isFav}
            onClick={handleFav}
            data-testid="bar-btn-fav"
            data-active={isFav ? "true" : "false"}
            aria-pressed={isFav}
            title={isOwner ? "You can't star your own app" : isFav ? "Already starred" : undefined}
          >
            <StarIcon width="16" height="16" />
            <span className="bar-label">Star</span>
            {details?.starCount === undefined ? (
              <span className="bar-count is-loading" aria-hidden="true" />
            ) : starCount > 0 ? (
              <span className="bar-count" data-testid="card-stars">{starCount}</span>
            ) : null}
          </button>
          {lockedHintOpen && (
            <LockedHint
              onClose={() => setLockedHintOpen(false)}
              anchorRef={favWrapRef}
            />
          )}
        </span>
        {moddable && (
          <span className="bar-btn-mod-wrap">
            <button
              ref={modAnchorRef}
              type="button"
              className={`bar-btn bar-btn-mod${modOpen ? " is-open" : ""}`}
              onClick={handleMod}
              data-testid="bar-btn-mod"
              aria-haspopup="dialog"
              aria-expanded={modOpen}
            >
              <Shuffle size={18} aria-hidden="true" />
              <span className="bar-label">Mod</span>
            </button>
            {modOpen && (
              <ModPopup
                domain={entry.domain}
                moddable={moddable}
                onClose={() => setModOpen(false)}
                anchorRef={modAnchorRef}
              />
            )}
          </span>
        )}
        <button
          type="button"
          className={`bar-btn bar-btn-share${shareCopied ? " is-copied" : ""}`}
          data-right="true"
          onClick={handleShare}
          data-testid="bar-btn-share"
        >
          <Share2 size={18} aria-hidden="true" />
          <span className="bar-label">{shareCopied ? "Link copied!" : "Share link"}</span>
        </button>
      </div>
    </article>
  );
});

// ---------------------------------------------------------------------------
// Install widget
// ---------------------------------------------------------------------------

export function InstallWidget() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_CMD);
    addUserActionBreadcrumb("Copy install command");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="install-widget">
      <span className="install-widget-title">Install {CLI_COMMAND} CLI</span>
      <div
        className={`install-line${copied ? " install-line-copied" : ""}`}
        onClick={handleCopy}
      >
        <span className="install-line-prompt">$</span>
        <span className="install-line-cmd">{INSTALL_CMD}</span>
        {copied ? <CheckIcon className="install-line-icon" /> : <CopyIcon className="install-line-icon" />}
        <span className={`install-line-tooltip${copied ? " install-line-tooltip-visible" : ""}`}>
          Copied!
        </span>
      </div>
    </div>
  );
}
