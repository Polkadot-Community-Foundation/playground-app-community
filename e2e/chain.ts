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
 * Chain client helpers — single shared connection to Paseo Asset Hub.
 *
 * Uses plain polkadot-api (NOT `@parity/product-sdk-chain-client`).
 * The chain-client routes RPC through host transport and so throws
 * `Host provider unavailable` outside Polkadot Desktop/Mobile — that's
 * by design for the app's runtime (the iframe code). Node-side helpers
 * here are independent oracles reading chain state, so they go direct
 * to polkadot-api with the descriptors package we already ship.
 *
 * Exposes the same shape `getTestClient()` did via chain-client
 * (`{ assetHub, raw: { assetHub }, destroy }`) so callers in registry.ts
 * and elsewhere don't change.
 *
 * Tests share a cached client. globalTeardown calls destroyTestClient()
 * so playwright's process can exit (the WebSocket would otherwise keep
 * the event loop alive).
 */

import { createClient, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { h160ToSs58, type HexString } from "@parity/product-sdk-address";

// Asset-hub RPC. Defaults to Summit Asset Hub (the production target); override
// with ASSET_HUB_WS_URL for Paseo or a custom endpoint. The `paseo_asset_hub`
// descriptor is still used for typed decoding (no Summit descriptor is published
// yet) — it decodes Summit AH as long as the runtime tracks Paseo Next v2.
const ASSET_HUB_RPC: string =
  process.env.ASSET_HUB_WS_URL ?? "wss://summit-asset-hub-rpc.polkadot.io";
const CONNECT_TIMEOUT_MS = 30_000;

export type AssetHubApi = TypedApi<typeof paseo_asset_hub>;

export interface TestClient {
  /** Typed Paseo Asset Hub API — has .query, .tx, .event, .constants. */
  assetHub: AssetHubApi;
  /** Raw PolkadotClient — what `createInkSdk` and similar low-level
   * helpers consume. Mirrors chain-client's `raw.assetHub` shape. */
  raw: { assetHub: PolkadotClient };
  destroy(): void;
}

let clientPromise: Promise<TestClient> | null = null;
let openClient: PolkadotClient | null = null;

export async function getTestClient(): Promise<TestClient> {
  if (!clientPromise) {
    clientPromise = Promise.race([
      (async () => {
        const polkadotClient = createClient(getWsProvider(ASSET_HUB_RPC));
        openClient = polkadotClient;
        const assetHub = polkadotClient.getTypedApi(paseo_asset_hub);
        return {
          assetHub,
          raw: { assetHub: polkadotClient },
          destroy: () => polkadotClient.destroy(),
        } satisfies TestClient;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Timed out connecting to Paseo Asset Hub after ${CONNECT_TIMEOUT_MS / 1000}s`,
              ),
            ),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export function destroyTestClient(): void {
  if (openClient) {
    openClient.destroy();
    openClient = null;
  }
  clientPromise = null;
}

/** Substrate-side balance of an ss58 address. */
export async function queryBalance(address: string): Promise<bigint> {
  const c = await getTestClient();
  const account = await c.assetHub.query.System.Account.getValue(address, {
    at: "best",
  });
  return account.data.free;
}

/** Revive/EVM-side balance of an h160 (h160 → mapped ss58 → System.Account). */
export async function queryH160Balance(h160: HexString): Promise<bigint> {
  return queryBalance(h160ToSs58(h160));
}
