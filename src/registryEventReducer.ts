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

import type { RegistryEventName } from "./utils/event-stream/registryEvents";
import type { AppEntry } from "./registryTypes";
import { VISIBILITY_PUBLIC } from "./registryTypes";

export {
  REGISTRY_EVENT_NAMES as EVENT_NAMES,
  TYPED_PAYLOAD_EVENTS,
} from "./utils/event-stream/registryEvents";
export type RegistryEvent = RegistryEventName;

/**
 * Pure: decide whether a fetched entry should be visible to the current
 * viewer. Mirrors the contract-side filter in `get_apps`: public apps
 * always show; private apps only show to their owner.
 *
 * `currentUserAddr` is compared case-insensitively against `entry.owner`.
 * Pass `null` / `undefined` when no account is connected.
 */
export function shouldIncludeEntry(
  entry: AppEntry,
  currentUserAddr: string | null | undefined,
): "keep" | "remove" {
  if (entry.visibility === VISIBILITY_PUBLIC) return "keep";
  const me = currentUserAddr?.toLowerCase();
  const isOwn = !!me && entry.owner?.toLowerCase() === me;
  return isOwn ? "keep" : "remove";
}

/**
 * Pure: upsert an entry into a list by domain. If the domain already
 * exists, merge fields into the existing record; otherwise prepend the
 * new entry so newest activity shows first.
 */
export function upsertEntry(prev: AppEntry[], entry: AppEntry): AppEntry[] {
  const exists = prev.some((e) => e.domain === entry.domain);
  return exists
    ? prev.map((e) => (e.domain === entry.domain ? { ...e, ...entry } : e))
    : [entry, ...prev];
}

/**
 * Pure: remove an entry from a list by domain. Returns the same array
 * reference when nothing changed, so callers using referential equality
 * can skip re-renders.
 */
export function removeEntry(prev: AppEntry[], domain: string): AppEntry[] {
  const next = prev.filter((e) => e.domain !== domain);
  return next.length === prev.length ? prev : next;
}

/**
 * Dependencies the registry-event handler needs to talk back to the
 * outside world. Side effects only — keep pure decision logic in the
 * helpers above and test those directly.
 */
export interface RegistryEventDeps {
  /** Read a single domain's full entry from chain. */
  fetchEntry(domain: string): Promise<AppEntry | null>;
  /** Apply an upsert/remove decision against the entries list. */
  applyDecision(entry: AppEntry, decision: "keep" | "remove"): void;
  /** Remove a domain unconditionally (used for Unpublished). */
  removeDomain(domain: string): void;
  /** Re-fetch the pinned-apps list (used for Pinned/Unpinned). */
  fetchPinnedApps(): void;
  /** Backfill metadata for entries that just appeared. */
  backfillDetails(entries: AppEntry[]): void;
  /** Current viewer's h160 address, or undefined when disconnected. */
  getCurrentUserAddr(): string | null | undefined;
  /** Re-fetch star + mod counts for a domain (used for Star/Mod events). */
  refreshSocialCounts(domain: string): void;
  /**
   * Re-fetch the leaderboard (top builders). Per-account surfaces (island
   * XP, task checks) refresh separately, scoped to the current user's own
   * events — see the subscription in App.tsx.
   */
  refreshLeaderboard(): void;
  /**
   * Re-read verified identities in every mounted hook. The identity events
   * (IdentityLinked / IdentityCleared / IdentityBonusAwarded) carry the
   * recipient but the per-account display reads aren't event-driven, so a
   * broadcast revalidation is the cheapest correct reaction — it's what lets a
   * reveal/clear done elsewhere (CLI, second tab) show up without a reload.
   */
  refreshIdentities(): void;
}

/**
 * Dispatch a registry event to the right side effects. Pure decision
 * logic lives in the helpers above; this function just orchestrates
 * the calls to `deps`.
 *
 * The async branch for Published/VisibilityChanged is fire-and-forget —
 * the caller doesn't await it. If `fetchEntry` rejects we swallow it
 * silently (matches prior in-line behaviour); chain reads in this path
 * are best-effort and a transient WS hiccup shouldn't surface as a
 * user-facing error.
 */
export function handleRegistryEvent(
  event: RegistryEvent,
  domain: string,
  deps: RegistryEventDeps,
): void {
  switch (event) {
    case "Published":
    case "VisibilityChanged": {
      void deps.fetchEntry(domain).then((entry) => {
        if (!entry) return;
        const decision = shouldIncludeEntry(entry, deps.getCurrentUserAddr());
        deps.applyDecision(entry, decision);
        if (decision === "keep") deps.backfillDetails([entry]);
      });
      return;
    }
    case "Unpublished":
      deps.removeDomain(domain);
      return;
    case "Pinned":
    case "Unpinned":
      deps.fetchPinnedApps();
      return;
    // Star toggles: refresh the per-domain counts + the leaderboard. The
    // recipient's per-account total is rolled into the leaderboard fetch.
    case "StarPointAwarded":
    case "StarPointRefunded":
      deps.refreshSocialCounts(domain);
      deps.refreshLeaderboard();
      return;
    // Mod credit: refresh the source domain's mod_count + leaderboard.
    // `domain` here is the SOURCE domain (decoded from the event payload),
    // not the mod's domain; the dispatcher is responsible for surfacing the
    // right value from the SCALE-decoded struct.
    case "ModPointAwarded":
      deps.refreshSocialCounts(domain);
      deps.refreshLeaderboard();
      return;
    // Deploy / publish / moddable points: refresh just the leaderboard.
    // The Published event already triggered the entry refresh.
    case "DeployPointAwarded":
    case "PlaygroundPublishPointAwarded":
    case "ModdablePointAwarded":
      deps.refreshLeaderboard();
      return;
    // Verified-identity events: a reveal/clear (and the one-time first-reveal
    // bonus) changes the displayed name and, for the bonus, the XP total.
    // Refresh the leaderboard (its batch root-account read re-resolves names
    // and picks up the score tick) and broadcast-refresh the per-account
    // identity hooks so an own/second-tab reveal shows up without a reload.
    case "IdentityLinked":
    case "IdentityCleared":
    case "IdentityBonusAwarded":
      deps.refreshLeaderboard();
      deps.refreshIdentities();
      return;
  }
}
