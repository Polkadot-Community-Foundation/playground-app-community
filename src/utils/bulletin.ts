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

import { useEffect, useState } from "react";
import {
  calculateCid,
  CloudStorageClient,
  createLazySigner,
} from "@parity/product-sdk-cloud-storage";
import { getPreimageManager } from "@parity/product-sdk-host";
import { CHAIN } from "../config.ts";
import { signerManager } from "./contracts.ts";
import { ensurePreimagePermission } from "./hostPermissions.ts";
import { SUBMIT_DEADLINE_MS, withDeadline, withReadDeadline } from "./deadline.ts";

// Lazy signer wraps the SignerManager so the bulletin client can be built
// before any account is selected. Account changes after sign-in are picked up
// automatically — each store call resolves the current signer.
//
// Promise-based singleton (rather than nullable + check) so concurrent first
// callers during page-load (every AppCard's useIconUrl + fetchMetadata) share
// one CloudStorageClient.create() instead of each spinning up their own.
let _bulletinClientPromise: Promise<CloudStorageClient> | null = null;

export function getBulletinClient(): Promise<CloudStorageClient> {
  if (!_bulletinClientPromise) {
    const signer = createLazySigner(() => {
      const acct = signerManager.getState().selectedAccount;
      return acct ? acct.getSigner() : null;
    });
    // Clear the slot on failure: the singleton caches a PROMISE, so a create()
    // that rejects under congestion would otherwise be reused forever, breaking
    // every icon/metadata fetch for the session until an app restart. Nulling
    // it lets the next caller rebuild and self-heal. Deadline the connect too
    // (mirrors the builder's getBuilderBulletinClient): a HANGING create never
    // rejects, so without this the cached promise stays pending forever and
    // EVERY icon + metadata fetch awaits it forever — the whole grid wedged on
    // one dead handshake. The deadline turns that into the same rejection the
    // `.catch` already self-heals from.
    _bulletinClientPromise = withReadDeadline(
      CloudStorageClient.create({ environment: CHAIN, signer }),
      "Bulletin client connection",
    ).catch((cause) => {
      _bulletinClientPromise = null;
      throw cause;
    });
  }
  return _bulletinClientPromise!;
}

// ── Authorized product-account WRITE path ──────────────────────────────────
//
// `getBulletinClient().store()` (CloudStorageClient) signs the store from the
// product account and sends it over the desktop↔phone statement relay (hard
// ~256 KB cap, observed failing well below that) — the host surfaces it as the
// generic "message too big" IPC error. The host's RFC-0002 preimage submission
// is the supported product-account write path: the bytes cross local IPC and
// the HOST submits to Bulletin under its own authorization, gated only by the
// `PreimageSubmit` permission — nothing transits the relay. This is the same
// route the site builder uses (src/builder/store.ts, viaHost), and it reuses
// the same shared helpers: `ensurePreimagePermission` (bounded + session-cached
// so onboarding and every write path share ONE grant) and `withDeadline` /
// `SUBMIT_DEADLINE_MS` for the submit bound. READS via
// `getBulletinClient().fetch*` are unaffected and stay as-is.

/**
 * Store `bytes` on Bulletin via the host preimage submission and return the
 * content CID. Use this for product-account *writes* instead of
 * `getBulletinClient().store()`. The CID is computed locally (raw codec, single
 * preimage); the host-returned key is verified against it so a silently
 * divergent store can't yield a 404 gateway URL.
 */
export async function storeBytesViaHost(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) throw new Error("Nothing to store — empty bytes");
  await ensurePreimagePermission();
  const manager = await getPreimageManager();
  if (!manager) {
    throw new Error(
      "Host preimage API unavailable — cannot store via the host on this platform",
    );
  }
  const cid = await calculateCid(bytes);
  // Bound the non-interactive submit (the one-time permission prompt is handled
  // and bounded inside ensurePreimagePermission above). A wedged host bridge
  // HANGS rather than rejects; without this the caller would await forever.
  // Same mechanism and bound the builder uses for its host store.
  const key = await withDeadline(manager.submit(bytes), SUBMIT_DEADLINE_MS, "Saving to Bulletin");
  // Verify the host stored what we sent (mirrors src/builder/store.ts): when the
  // returned key is a comparable 32-byte hex, a mismatch means the host stored
  // something other than what we sent and the gateway URL would 404.
  const digestHex = `0x${Array.from(cid.multihash.digest, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")}`;
  if (/^0x[0-9a-f]{64}$/i.test(key) && key.toLowerCase() !== digestHex) {
    throw new Error(
      `Host preimage key ${key} doesn't match the expected blake2b-256 digest ` +
        `${digestHex} — the stored bytes may differ from what was sent`,
    );
  }
  return cid.toString();
}

// Icon CIDs are content-addressed and immutable, so blob URLs can be cached
// for the session. Session-lifetime cache; the underlying bytes stay alive in
// the renderer until the page unloads (no `URL.revokeObjectURL` calls). Memory
// is roughly (unique-icons × icon-size); fine for V1 registry sizes. If the
// registry grows past a few hundred unique icons or sessions get pinned to
// venue displays for hours, swap this for a bounded LRU + revoke-on-eviction.
const _iconBlobCache = new Map<string, string>();
const _iconInFlight = new Map<string, Promise<string | null>>();

function fetchIconUrl(cid: string): Promise<string | null> {
  const cached = _iconBlobCache.get(cid);
  if (cached) return Promise.resolve(cached);
  const inFlight = _iconInFlight.get(cid);
  if (inFlight) return inFlight;
  const p = (async (): Promise<string | null> => {
    try {
      const client = await getBulletinClient();
      // Deadline the fetch itself: past a healthy connect a single fetchBytes
      // can still hang on a wedged host bridge, which would pin this icon's
      // in-flight entry (and its AppCard spinner) forever. A timeout lands in
      // the catch below → the tile degrades to its placeholder.
      const bytes = await withReadDeadline(client.fetchBytes(cid), "Bulletin icon fetch");
      // Blob's typed BlobPart rejects Uint8Array<ArrayBufferLike> on lib.dom 2024+,
      // even though every concrete Uint8Array works at runtime.
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      _iconBlobCache.set(cid, url);
      return url;
    } catch {
      // fetchBytes throws CloudStorageHostUnavailableError outside a Polkadot
      // host (Desktop/Mobile). The grid degrades to placeholders.
      return null;
    }
  })().finally(() => _iconInFlight.delete(cid));
  _iconInFlight.set(cid, p);
  return p;
}

export function useIconUrl(cid: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    cid ? _iconBlobCache.get(cid) ?? null : null,
  );
  useEffect(() => {
    if (!cid) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetchIconUrl(cid).then(u => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [cid]);
  return url;
}
