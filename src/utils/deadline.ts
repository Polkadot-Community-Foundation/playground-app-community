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

// Deadlines for chain interactions across the app — the deploy pipeline AND
// the registry-grid reads in utils/contracts.ts. An unhealthy connection
// (stalled light client, half-proxied RPC gateway, wedged host bridge)
// typically HANGS rather than rejects, freezing whatever is awaiting it
// forever (a deploy stuck on a stale status line; the Apps grid stuck on
// skeletons). Routing every chain call through one of these deadlines turns a
// dead connection into a thrown, actionable error the caller's existing
// failure handling can surface. Retrying after one is safe by construction:
// reads are idempotent, Bulletin stores dedupe by content, commitments stay
// valid until maxCommitmentAge, and re-registers dry-run first.

/** Reads / dry-runs / connection handshakes — no user interaction can be
 *  pending. Handshake-bound rather than block-bound, so this stays generous
 *  enough to cover a cold light-client / host-bridge warm-up. */
export const READ_DEADLINE_MS = 45_000;
/** Non-interactive submits: the Bulletin store (host preimage submit, or the
 *  dev-key direct store). No phone prompt is involved — the work is purely
 *  getting the blob into a block, and every submit waits for IN-BLOCK, not
 *  finality. Budget ≈ 7 blocks of inclusion at ~6s + jitter; if a store
 *  hasn't landed by then the chain backend is wedged, not slow. */
export const SUBMIT_DEADLINE_MS = 45_000;
/** Interactive submits: a signed tx (DotNS commit / register / link) or the
 *  host allowance grant, where the user must approve on their phone. The host
 *  itself caps the signing prompt at 60s (SIGNING_TIMEOUT_MS in
 *  polkadot-desktop) and returns a clearer error, so we sit just above it:
 *  ~60s human-approval window + ~30s for the approved tx to reach in-block.
 *  This only fires as a true hang backstop — on a real signing timeout the
 *  host's 60s error wins first. */
export const SIGN_DEADLINE_MS = 90_000;

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(
      `${label} took too long to respond. This is usually a temporary ` +
        `connection problem, please try again.`,
    );
    this.name = "DeadlineError";
  }
}

export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/** Convenience for the common case: bound a read / dry-run by READ_DEADLINE_MS.
 *  Used pervasively by the registry-grid and profile reads (App.tsx,
 *  MyAppsWidget, useTaskProgress, utils/bulletin) so a wedged host bridge that
 *  HANGS rather than rejects surfaces as a rejection the caller's existing
 *  try/catch maps to its normal fallback, instead of pinning a tile / list /
 *  panel on a spinner forever. */
export function withReadDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return withDeadline(promise, READ_DEADLINE_MS, label);
}
