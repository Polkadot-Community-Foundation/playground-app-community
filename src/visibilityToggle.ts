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

import { VISIBILITY_PUBLIC, type AppEntry } from "./registryTypes";

/**
 * Operation-shaped deps the visibility-toggle flow needs. Same pattern
 * as publishFlow.ts — adapters at the call site map these onto
 * `@parity/product-sdk-contracts` and the App's state hooks, so the
 * flow stays independent of SDK types and testable with plain mocks.
 */
export interface VisibilityToggleClients {
  /** Submit a `registry.setVisibility(domain, vis)` transaction. */
  setVisibility(domain: string, vis: number): Promise<{ ok: boolean }>;
  /** Read a single domain's entry after a public flip. */
  fetchEntry(domain: string): Promise<AppEntry | null>;
}

/**
 * Side-effect callbacks the flow drives. The component supplies these
 * from useState setters + telemetry helpers; tests pass plain spies.
 */
export interface VisibilityToggleReporter {
  /** Announce the user-action breadcrumb before submitting. */
  breadcrumb(opts: { domain: string; visibility: "public" | "private" }): void;
  /** Drop the domain from the in-memory entries list on a private flip. */
  removeDomain(domain: string): void;
  /** Prepend a fetched entry on a public flip (newest activity first). */
  prependEntry(entry: AppEntry): void;
  /** Backfill metadata details for a newly-public entry. */
  backfillDetails(entries: AppEntry[]): void;
  /** Patch the open mod-detail panel when the toggled domain matches it. */
  patchModEntry(domain: string, vis: number): void;
  /** Whether the caught error was a user-cancelled signing prompt — */
  /** silently swallowed if so. */
  isSigningRejection(err: unknown): boolean;
  /** Report unexpected errors to telemetry. */
  captureException(err: unknown, tags: { action: string; domain: string }): void;
}

/**
 * Submit a setVisibility transaction and reconcile in-memory state to
 * match. Pure orchestration: the tx + reads go through `clients`, every
 * state mutation goes through `reporter`. Tests inject mocks; the
 * component injects real SDK + setters.
 *
 * Does NOT throw on signing rejections (user cancelled the wallet
 * prompt) — that's caught silently. Other errors are reported to
 * telemetry then re-thrown so the caller can decide UI behaviour.
 */
export async function runVisibilityToggle(
  domain: string,
  vis: number,
  clients: VisibilityToggleClients,
  reporter: VisibilityToggleReporter,
): Promise<void> {
  reporter.breadcrumb({
    domain,
    visibility: vis === VISIBILITY_PUBLIC ? "public" : "private",
  });
  try {
    const result = await clients.setVisibility(domain, vis);
    if (!result.ok) {
      throw new Error(`setVisibility tx returned ok=false for ${domain}`);
    }

    if (vis === VISIBILITY_PUBLIC) {
      // Public flip: fetch the canonical entry and prepend it to the list
      // (newest activity surfaces at the top of the recents grid). Skip
      // gracefully if the entry isn't queryable yet — typically transient
      // indexer lag right after a public flip.
      const entry = await clients.fetchEntry(domain);
      if (entry) {
        reporter.prependEntry(entry);
        reporter.backfillDetails([entry]);
      }
    } else {
      // Private flip: drop from the public-viewable lists. Owner still
      // sees it via the My Apps grid (which subscribes separately).
      reporter.removeDomain(domain);
    }

    // Either way, sync the open mod-detail panel if it's showing this
    // domain — otherwise users see stale "public" / "private" copy.
    reporter.patchModEntry(domain, vis);
  } catch (err) {
    if (reporter.isSigningRejection(err)) return;
    reporter.captureException(err, { action: "set-visibility", domain });
    throw err;
  }
}
