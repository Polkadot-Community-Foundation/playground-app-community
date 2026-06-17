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

// "Resources" — the onboarding gate. A user can browse freely, but writing
// on-chain (publishing, starring, claiming a handle) is paid from the product
// account's PGAS balance, provisioned by the host `SmartContractAllowance`.
// The "Become a builder" flow turns that provisioning into a deliberate,
// explained first step instead of an unexplained mid-action host prompt.
//
// PGAS is authoritative on-chain (see the long note in contracts.ts): it only
// ever goes absent→present (a granted allowance lands as a balance and persists
// across host restarts). That one-way property is why the snapshot below only
// ever persists the positive and a failed read never regresses a known `true`.

import { useCallback, useEffect, useState } from "react";
import type { SignerAccount } from "@parity/product-sdk-signer";
import { provisionResources, hasPgasOnChain } from "./contracts.ts";

/**
 * Provision network resources for the connected account: connect (if needed),
 * fire a single batched host dialog covering the deploy allowances we use
 * (BulletinAllowance + SmartContractAllowance — StatementStore is not requested,
 * unused at this time), and send a dev-only Alice top-up of 100 PAS (stand-in
 * for the production PGAS claim path handled by the Polkadot mobile app).
 *
 * One host dialog instead of separate prompts. On-chain spend txs remain
 * sequential — only the host permission request is batched.
 *
 * Resolves once resources are in place. Throws {@link PermissionDeniedError}
 * when the user cancels/denies the required SmartContractAllowance host prompt —
 * callers surface a soft "try again" rather than a hard failure.
 *
 * The returned `funded` is the authoritative signal: `false` means every funder
 * source (dedicated mnemonic → Alice → contract faucet) failed and the account
 * holds no spendable tokens, so callers must tell the user we're out of resources
 * rather than claim success.
 */
export async function requestResources(): Promise<{ funded: boolean }> {
  return provisionResources();
}

// Per-account positive memo. Keyed by lowercased H160 so it survives reload and
// paints the correct gate on the first frame (perceived-performance rule). Only
// `true` is ever written — a never-granted account simply has no entry.
const RESOURCES_SNAPSHOT_KEY = "pg.resources.v1";

function readResourceSnapshot(h160: string): boolean {
  try {
    const raw = localStorage.getItem(RESOURCES_SNAPSHOT_KEY);
    if (!raw) return false;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return map[h160.toLowerCase()] === true;
  } catch {
    return false;
  }
}

function writeResourceSnapshot(h160: string): void {
  try {
    const raw = localStorage.getItem(RESOURCES_SNAPSHOT_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    map[h160.toLowerCase()] = true;
    localStorage.setItem(RESOURCES_SNAPSHOT_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — snapshot is an optimisation only */
  }
}

/**
 * Record that an account's resources are present, optimistically. Called right
 * after {@link requestResources} resolves: the host only reports the allowance
 * `Allocated` (or PGAS already present) on that path, and PGAS never regresses,
 * so the positive is authoritative even before the balance is indexed on-chain.
 *
 * Writing the snapshot here (rather than waiting for the post-grant chain read)
 * is what lets {@link usePgasAllowance}'s `refresh()` flip the gate instantly —
 * without it, a 1-block indexing lag would leave the gate locked until reload.
 */
export function confirmResourcesGranted(h160: string): void {
  writeResourceSnapshot(h160);
}

export interface PgasAllowance {
  /** Does the connected account hold resources (PGAS)? The unlock gate. */
  hasResources: boolean;
  /** A background chain read is in flight and the value isn't yet confirmed. */
  loading: boolean;
  /** Force a re-read (e.g. right after a successful `requestResources`). */
  refresh: () => void;
}

/**
 * Reactive resources gate for `account`. Seeds synchronously from the snapshot
 * (so a returning builder never sees a flash of the locked UI), then reconciles
 * against the chain. Because PGAS only goes false→true, a cached `true` short
 * -circuits the read and a failed read never regresses to `false`.
 */
export function usePgasAllowance(
  account: SignerAccount | undefined,
  refreshKey = 0,
): PgasAllowance {
  const h160 = account?.h160Address?.toLowerCase();

  const [state, setState] = useState<{ addr?: string; has: boolean }>(() => ({
    addr: h160,
    has: h160 ? readResourceSnapshot(h160) : false,
  }));
  const [loading, setLoading] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);

  // Re-seed synchronously on account switch so a frame of the previous
  // account's gate never paints (mirrors the useTaskProgress seed approach).
  if (state.addr !== h160) {
    setState({ addr: h160, has: h160 ? readResourceSnapshot(h160) : false });
  }

  useEffect(() => {
    if (!account || !h160) {
      setLoading(false);
      return;
    }
    // Cached true — PGAS persists, so no read can change the answer. Adopt the
    // snapshot into state in case it was written *after* mount (e.g. an
    // optimistic confirmResourcesGranted followed by refresh()), where the
    // synchronous account-switch re-seed above wouldn't have picked it up.
    if (readResourceSnapshot(h160)) {
      if (!state.has) setState({ addr: h160, has: true });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    hasPgasOnChain(account)
      .then((has) => {
        if (cancelled) return;
        if (has) {
          writeResourceSnapshot(h160);
          setState({ addr: h160, has: true });
        }
        // A `false` read leaves the seeded value alone (never regress).
      })
      // hasPgasOnChain already swallows its own errors (returns false), but
      // guard anyway so a future change can't float an unhandled rejection.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, h160, refreshKey, localRefresh]);

  const refresh = useCallback(() => setLocalRefresh((n) => n + 1), []);

  return { hasResources: state.has, loading, refresh };
}
