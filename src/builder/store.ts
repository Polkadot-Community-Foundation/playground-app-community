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

// Bulletin storage via CloudStorageClient (playground's SDK environment).
// Replaces hello-playground's two store routes (host preimage + direct
// authorized TransactionStorage.store) with the one SDK path.
//
// The client is BUILDER-OWNED (not playground's `getBulletinClient()`
// singleton) because the builder supports the dev account: the lazy signer
// resolves whatever account the caller passes per store, host or dev,
// while playground's singleton is bound to signerManager exclusively.

import {
  ChunkStatus,
  CloudStorageClient,
  TxStatus,
  calculateCid,
  createLazySigner,
  type ProgressEvent,
} from "@parity/product-sdk-cloud-storage";
import { getPreimageManager } from "@parity/product-sdk-host";
import { ensurePreimagePermission } from "../utils/hostPermissions.ts";
import type { PolkadotSigner } from "polkadot-api";
import { CHAIN } from "../config.ts";
import { BULLETIN_GATEWAY } from "./config.ts";
import { READ_DEADLINE_MS, SUBMIT_DEADLINE_MS, withDeadline } from "../utils/deadline.ts";
import type { DeployStatus } from "./submit-and-wait.ts";

export { calculateCid };

export interface StoreHTMLResult {
  cid: string;
  /** Null when the receipt doesn't carry inclusion info. */
  blockNumber: number | null;
  blockHash: string | null;
  ipfsUrl: string;
  bytes: number;
}

export interface AuthCheck {
  /** Whether a usable authorization entry exists for this account. */
  authorized: boolean;
  remainingTransactions: number;
  remainingBytes: bigint;
  /** Block number when the authorization expires. 0 if not authorized. */
  expiration: number;
}

// The lazy signer resolves the account of the in-flight store. Only one
// account is ever active in the builder at a time, and stores within one
// upload are sequential, so a single slot is race-free in practice.
let currentSigner: PolkadotSigner | null = null;

let clientPromise: Promise<CloudStorageClient> | null = null;
function getBuilderBulletinClient(): Promise<CloudStorageClient> {
  // Self-healing singleton: `??=` caches the create() PROMISE, so a rejected or
  // (via withDeadline) timed-out create would otherwise be reused forever,
  // breaking every later store/auth-check until an app restart. Null the slot
  // on failure so the next caller rebuilds. See chain.ts for the same pattern.
  return (clientPromise ??= withDeadline(
    CloudStorageClient.create({
      environment: CHAIN,
      signer: createLazySigner(
        () => currentSigner,
        "Builder store called with no active account signer",
      ),
    }),
    READ_DEADLINE_MS,
    "Bulletin client connection",
  ).catch((cause) => {
    clientPromise = null;
    throw cause;
  }));
}

// Map the SDK's progress events onto the status vocabulary the builder's
// progress UI already understands (see stepForUploadStatus in BuilderApp).
function statusFor(event: ProgressEvent): DeployStatus | null {
  switch (event.type) {
    case TxStatus.Signed:
      return "signing";
    case TxStatus.Broadcasted:
      return "broadcasting";
    case TxStatus.InBlock:
      return "in-block";
    case TxStatus.Finalized:
      return "finalized";
    case ChunkStatus.ChunkStarted:
    case ChunkStatus.ChunkCompleted:
    case ChunkStatus.ChunkFailed:
      return null; // chunk counts handled via the label below
    default:
      return null;
  }
}

// Drop the memoized Bulletin client so the next store / auth-check rebuilds it.
// Mirrors resetAssetHubClient in chain.ts: the socket behind a long-lived
// client can wedge after the WebView is backgrounded — e.g. while the user is
// away at a faucet — leaving checkAuthorization / store pending forever. The
// self-healing `??=` only nulls the slot on a CREATE failure, not on a wedged
// query against an already-built client, so an explicit reset is the only
// recovery short of a page reload. The deploy panel calls this (alongside
// resetAssetHubClient) before a re-check so recovery needs no reload.
export function resetBuilderBulletinClient(): void {
  clientPromise = null;
}

export async function checkBulletinAuthorization(address: string): Promise<AuthCheck> {
  const client = await getBuilderBulletinClient();
  const status = await client.checkAuthorization(address);
  return {
    authorized: status.authorized,
    remainingTransactions: status.remainingTransactions,
    remainingBytes: status.remainingBytes,
    expiration: status.expiration,
  };
}

export async function storeBytes(params: {
  bytes: Uint8Array;
  signer: PolkadotSigner;
  label?: string;
  /**
   * Host accounts route through the host's preimage submission (RFC-0002):
   * the bytes cross local IPC and the HOST submits to Bulletin under its
   * own authorization. This is what BulletinAllowance actually grants —
   * no per-blob signing, so nothing transits the desktop↔phone statement
   * relay (hard 256 KB cap, observed failing well below that), and the
   * product account needs no Bulletin authorization of its own. Dev
   * accounts sign direct authorized TransactionStorage.store as before.
   */
  viaHost?: boolean;
  onStatus?: (status: DeployStatus | string) => void;
}): Promise<StoreHTMLResult> {
  const { bytes, signer, label = "Content", viaHost, onStatus } = params;

  if (bytes.length === 0) throw new Error(`${label} is empty — nothing to store`);

  if (viaHost) {
    // Status tags map onto the stages the direct route reports: the
    // permission prompt ≈ signing, host submission ≈ broadcast.
    onStatus?.("signing");
    await ensurePreimagePermission();
    const manager = await getPreimageManager();
    if (!manager) {
      throw new Error(
        "Host preimage API unavailable — cannot store via the host on this platform",
      );
    }
    const cid = await calculateCid(bytes);
    onStatus?.("broadcasting");
    const key = await withDeadline(
      manager.submit(bytes),
      SUBMIT_DEADLINE_MS,
      "Saving your site to Bulletin",
    );
    // The returned key is the preimage hash. When it's a comparable 32-byte
    // hex, verify it matches our blake2b-256 digest — a mismatch means the
    // host stored (or hashed) something other than what we sent, and the
    // gateway URL we'd report would 404. Unrecognized key formats pass
    // through: a host-side format change must not fail every upload.
    const digestHex = `0x${Array.from(cid.multihash.digest, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")}`;
    if (/^0x[0-9a-f]{64}$/i.test(key) && key.toLowerCase() !== digestHex) {
      throw new Error(
        `Host preimage key ${key} doesn't match the expected blake2b-256 ` +
          `digest ${digestHex} — the stored bytes may differ from what was sent`,
      );
    }
    onStatus?.("finalized");
    return {
      cid: cid.toString(),
      blockNumber: null,
      blockHash: null,
      ipfsUrl: `${BULLETIN_GATEWAY}${cid.toString()}`,
      bytes: bytes.length,
    };
  }

  const client = await getBuilderBulletinClient();
  currentSigner = signer;
  try {
    onStatus?.("signing");
    // Deadline-bound like the host route above: a stalled Bulletin node HANGS
    // rather than rejects, which would otherwise pin an image upload's spinner
    // (or the deploy's Store step) open forever with no recovery. Retrying is
    // safe — Bulletin dedupes by content.
    const result = await withDeadline(
      client
        .store(bytes)
        .withWaitFor("in_block")
        .withCallback((event) => {
          if (event.type === ChunkStatus.ChunkStarted) {
            onStatus?.(`signing chunk ${event.index + 1}/${event.total}`);
            return;
          }
          const status = statusFor(event);
          if (status) onStatus?.(status);
        })
        .send(),
      SUBMIT_DEADLINE_MS,
      "The Bulletin store",
    );

    // Use the RECEIPT's CID, never a locally computed one: for content
    // above one chunk it's the DAG-PB manifest CID, which a raw-codec CID
    // computed over the input bytes would not match.
    if (!result.cid) {
      throw new Error(
        `${label} stored but the receipt carries no CID — cannot build a gateway URL`,
      );
    }
    return {
      cid: result.cid.toString(),
      blockNumber: result.blockNumber ?? null,
      blockHash: null,
      ipfsUrl: `${BULLETIN_GATEWAY}${result.cid.toString()}`,
      bytes: result.size,
    };
  } finally {
    currentSigner = null;
  }
}

export async function storeHTML(params: {
  html: string;
  signer: PolkadotSigner;
  viaHost?: boolean;
  onStatus?: (status: DeployStatus | string) => void;
}): Promise<StoreHTMLResult> {
  return storeBytes({
    bytes: new TextEncoder().encode(params.html),
    signer: params.signer,
    label: "HTML",
    viaHost: params.viaHost,
    onStatus: params.onStatus,
  });
}
