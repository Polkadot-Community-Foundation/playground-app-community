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

// Builder account layer over playground's signerManager — the SAME
// logged-in product account the rest of playground uses (read-only imports;
// playground core is not modified). Plus the wallet-less dev account, kept
// as a production fallback for users who show up with no account.

import { useMemo } from "react";
import type { PolkadotSigner } from "polkadot-api";
import { ss58Encode, truncateAddress } from "@parity/product-sdk-address";
import { createDevSigner, getDevPublicKey } from "@parity/product-sdk-tx";
import { ensureSignerReady, useSignerState } from "../utils/contracts.ts";
import { withDeadline, SIGN_DEADLINE_MS } from "../utils/deadline.ts";

export type AccountSource = "host" | "dev";

/** The uniform shape the vendored editor/deploy code consumes. */
export interface ActiveAccount {
  source: AccountSource;
  address: string;
  displayName: string;
  signer: PolkadotSigner;
}

const DEV_ACCOUNT_NAME = "Bob";

let devAccountCache: ActiveAccount | null = null;

/**
 * Synchronous — the dev key needs no network, just a deterministic
 * derivation. Deliberately not named after the derivation in UI copy:
 * it's a throwaway dev key, and a human name reads like a real account.
 */
export function getDevAccount(): ActiveAccount {
  return (devAccountCache ??= {
    source: "dev",
    address: ss58Encode(getDevPublicKey(DEV_ACCOUNT_NAME)),
    displayName: "Dev account",
    signer: createDevSigner(DEV_ACCOUNT_NAME),
  });
}

export interface HostAccountState {
  /** Playground's logged-in product account, or null when signed out. */
  account: ActiveAccount | null;
  /** True while signerManager's (auto-)connect is in flight. */
  connecting: boolean;
}

/** Reactive view of playground's signed-in account in the builder's shape. */
export function useHostAccount(): HostAccountState {
  const state = useSignerState();
  const selected = state.selectedAccount;
  const account = useMemo<ActiveAccount | null>(() => {
    if (!selected) return null;
    return {
      source: "host",
      address: selected.address,
      displayName: selected.name ?? truncateAddress(selected.address),
      signer: selected.getSigner(),
    };
  }, [selected]);
  return { account, connecting: state.status === "connecting" };
}

/**
 * Make `account` ready to submit: for the host account this connects (if
 * needed) and requests the SmartContract/Bulletin allowances via
 * playground's shared `ensureSignerReady` (one cached host prompt). The dev
 * account signs with its own key and pays its own fees — nothing to grant.
 */
export async function ensureAccountReady(account: ActiveAccount): Promise<void> {
  if (account.source === "host") {
    // Deadline-bound: ensureSignerReady requests host allowances over the
    // desktop↔phone bridge, which can WEDGE (e.g. the WebView frozen while the
    // user approves on their phone) and never settle — that would pin the
    // deploy on "Preparing deploy…" forever. SIGN_DEADLINE_MS (90s) covers the
    // host's own 60s approval window plus the grant landing on chain, so a real
    // prompt the user is acting on isn't cut short; it only fires on a
    // genuinely dead bridge, turning a silent lockup into a retryable error.
    // ensureSignerReady self-clears its shared promise, so a retry reconnects.
    await withDeadline(ensureSignerReady(), SIGN_DEADLINE_MS, "Preparing your account");
  }
}

/** Explicit connect for the signed-out state (surfaces the host dialog). */
export async function connectHostAccount(): Promise<void> {
  await withDeadline(ensureSignerReady(), SIGN_DEADLINE_MS, "Connecting your account");
}
