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

/**
 * Adapter seam for DotNS identity signing — mirrors product-sdk
 * `wallet.signMessageWithDotNsIdentity`, implemented against this app's shared
 * People-chain connection + the host accounts provider so the reveal flow stays
 * unchanged:
 *   1. Resolve the username to its owning root `AccountId32` on the People
 *      chain (`Resources.UsernameOwnerOf`).
 *   2. Sign the binding with that root account via the host accounts provider's
 *      `getLegacyAccountSigner({ publicKey, name }).signBytes(...)` — the path
 *      the merged product-sdk `createApp.signMessageWithDotNsIdentity` uses.
 *
 * The host signs the named account even though `productAccount`-only sessions
 * never enumerate it (`getLegacyAccounts()` is empty); naming it explicitly is
 * what makes identity signing work here.
 */

import { accountIdBytes } from "@parity/product-sdk-address";
import { getAccountsProvider } from "@parity/product-sdk-host";
import { utf8ToBytes } from "@parity/product-sdk-utils";
import { bytesToHex0x } from "../registryUtils.ts";
import { fetchHostUserId, individualityReady } from "./contracts.ts";

/** Mirrors product-sdk `DotNsIdentitySignature`. */
export interface DotNsIdentitySignature {
  username: string;
  accountId: `0x${string}`;
  signature: Uint8Array;
}

/** Mirrors product-sdk `SignMessageWithDotNsIdentityArgs`. `peopleChain` is a
 *  chain DESCRIPTOR; `username` omitted → host's primary username. */
export interface SignIdentityArgs {
  peopleChain: unknown;
  message: string | Uint8Array;
  username?: string;
}

/**
 * Sign the identity-binding message with the connected user's DotNS root
 * account; returns the `{ username, accountId, signature }` triple the reveal
 * flow submits to `set_identity`. Throws (handled by `revealIdentity`'s
 * rejection/failure mapping) when no username is available, the username owns no
 * account, the host accounts provider is unavailable, or the host declines.
 */
export async function signIdentityMessage(args: SignIdentityArgs): Promise<DotNsIdentitySignature> {
  const message = typeof args.message === "string" ? utf8ToBytes(args.message) : args.message;

  // Username to bind: caller-supplied, else the host's primary DotNS name.
  const username = (args.username ?? (await fetchHostUserId()) ?? "").trim();
  if (!username) {
    throw new Error("No DotNS username available from the host to sign with.");
  }

  // Resolve username → owning root AccountId32 via the app's shared
  // individuality connection (so `args.peopleChain` is intentionally unused).
  // The storage key is the bare UTF-8 label (e.g. "alice", not "alice.dot").
  const individuality = await individualityReady;
  const ownerSs58 = await individuality.query.Resources.UsernameOwnerOf.getValue(
    utf8ToBytes(username),
  );
  if (!ownerSs58) {
    throw new Error(`No account owns DotNS username "${username}".`);
  }
  const rootPubkey = accountIdBytes(ownerSs58);
  const accountId = bytesToHex0x(rootPubkey);

  // Sign via the host accounts provider's legacy-signer path (matches merged
  // createApp.signMessageWithDotNsIdentity). `signBytes` reaches
  // `host_sign_raw_with_legacy_account`; the host's `<Bytes>` wrapping is
  // platform-dependent, which the contract's both-form verify absorbs.
  const accountsProvider = await getAccountsProvider();
  if (!accountsProvider) {
    throw new Error("Host accounts provider unavailable (not in a host container?).");
  }
  const signer = accountsProvider.getLegacyAccountSigner({ publicKey: rootPubkey, name: username });
  const signature = await signer.signBytes(message);

  return { username, accountId, signature };
}
