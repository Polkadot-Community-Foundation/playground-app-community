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
 * Playground registry contract query + publish helpers.
 *
 * Reads the same cdm.json the app does and applies the same live CDM
 * meta-registry resolution (via `ContractManager.fromLiveClient`) so the
 * addresses we query match what the iframe is talking to. Without this
 * mirror the test asserter and the app can drift onto different deployed
 * contracts — exactly the kind of silent regression this suite exists to
 * catch.
 */

import {
  ContractManager,
  createContractRuntimeFromClient,
  ensureContractAccountMapped,
  type CdmJson,
  type ContractRuntime,
} from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { calculateCid, CloudStorageClient } from "@parity/product-sdk-cloud-storage";
import { keccak256, utf8ToBytes } from "@parity/product-sdk-utils";
import { seedToAccount } from "@parity/product-sdk-keys";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTestClient } from "./chain.js";
import { SIGNER } from "./accounts.js";
import {
  PLAYGROUND_REGISTRY_CONTRACT,
  REPUTATION_CONTRACT,
} from "../src/utils/contractManifest.js";

// product-sdk client environment for Bulletin/cloud-storage. Summit is the
// production target; override with PRODUCT_SDK_ENV=paseo for Paseo runs.
// NOTE: "summit" requires a product-sdk build that ships a Summit env — until
// then CloudStorageClient.create will reject it. See the e2e Summit blockers
// in PLAYGROUND_SUMMIT_VM_RUNBOOK.
const PRODUCT_SDK_ENV = (process.env.PRODUCT_SDK_ENV ?? "summit") as "paseo" | "summit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cdmJsonSnapshot = JSON.parse(
  readFileSync(join(__dirname, "..", "cdm.json"), "utf-8"),
) as CdmJson;

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

/** Re-derive the SIGNER's polkadot-api signer for node-side tx submission. */
function getSignerKeypair() {
  const isDevPath = SIGNER.uri.startsWith("//");
  return isDevPath
    ? seedToAccount(DEV_PHRASE, SIGNER.uri)
    : seedToAccount(SIGNER.uri, "");
}

type Contract = ReturnType<InstanceType<typeof ContractManager>["getContract"]>;

let manager: ContractManager | null = null;

async function getManager(): Promise<ContractManager> {
  if (!manager) {
    const acct = getSignerKeypair();
    const runtime = await getRuntime();
    // Match the app's contract resolution exactly. App reads addresses from
    // the on-chain CDM meta-registry on boot — we do the same here. Strict
    // fail: if the live resolution rejects we want the test run to surface
    // it, not silently fall back to a stale snapshot address.
    manager = await ContractManager.fromLive(cdmJsonSnapshot, runtime, {
      defaultSigner: acct.signer,
      defaultOrigin: SIGNER.address,
      registryOrigin: SIGNER.address,
      libraries: [PLAYGROUND_REGISTRY_CONTRACT, REPUTATION_CONTRACT],
    });
  }
  return manager;
}

async function getRegistry(): Promise<Contract> {
  return (await getManager()).getContract(PLAYGROUND_REGISTRY_CONTRACT);
}

async function getReputation(): Promise<Contract> {
  return (await getManager()).getContract(REPUTATION_CONTRACT);
}

export interface AppEntry {
  domain: string;
  metadataUri: string;
}

export async function getApp(domain: string): Promise<AppEntry | null> {
  const registry = await getRegistry();
  const res = await registry.getMetadataUri.query(domain);
  // Post product-sdk-contracts 0.5: a successful query for an unset Option
  // returns { success: true, value: undefined } (previously { isSome: false }).
  // Guard both shapes so a missing fixture surfaces as null, not a TypeError.
  if (!res.success || !res.value) return null;
  const v = res.value as { isSome: boolean; value: string };
  if (!v.isSome) return null;
  return { domain, metadataUri: v.value };
}

export async function getAppCount(): Promise<number> {
  const registry = await getRegistry();
  const res = await registry.getAppCount.query();
  return res.success ? Number(res.value) : 0;
}

export async function waitForApp(domain: string, timeoutMs = 30_000): Promise<AppEntry> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = await getApp(domain);
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`waitForApp: '${domain}' not found in registry after ${timeoutMs}ms`);
}

/** Inverse of `waitForApp`: poll until the domain is gone, or throw on timeout. */
export async function waitForUnpublish(domain: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await getApp(domain)) === null) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`waitForUnpublish: '${domain}' still present in registry after ${timeoutMs}ms`);
}

/** Visibility constants — must match the values App.tsx exports. */
export const VISIBILITY_PRIVATE = 0;
export const VISIBILITY_PUBLIC = 1;

/**
 * Toggle an existing domain's visibility. Caller must be the domain owner
 * (or sudo/admin). Used by setup/teardown to keep the fixture domain
 * `playground-e2e-app.dot` hidden from the public registry between runs —
 * setup flips PUBLIC at start of each Playwright invocation, teardown flips
 * PRIVATE at end. Race risk between parallel CI jobs (reads + writes both
 * doing setup→teardown on the same fixture) is documented in the test plan.
 */
export async function setVisibility(domain: string, visibility: number): Promise<void> {
  const registry = await getRegistry();
  const result = await registry.setVisibility.tx(domain, visibility);
  if (!result.ok) {
    throw new Error(
      `registry.setVisibility('${domain}', ${visibility}) failed: ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }
}

/**
 * Ensure the SIGNER's account is mapped on the Revive pallet.
 *
 * Asset Hub Revive requires every account to call `Revive.map_account()`
 * once before it can call EVM contracts. A fresh account (like the
 * dedicated funder we generated) has never been mapped — its first
 * contract call fails with `Revive.AccountUnmapped`. We map idempotently:
 * if the account is already mapped, ensureAccountMapped is a no-op.
 */
export async function ensureSignerMapped(): Promise<void> {
  const acct = getSignerKeypair();
  const runtime = await getRuntime();
  const result = await ensureContractAccountMapped(
    runtime,
    SIGNER.address,
    acct.signer,
    {
      onStatus: (status) => {
        if (status === "already-mapped") {
          console.log(`[e2e setup] Signer already mapped on Revive`);
        } else if (status === "mapping") {
          console.log(`[e2e setup] Mapping signer on Revive (one-time setup)…`);
        } else if (status === "mapped") {
          console.log(`[e2e setup] Signer mapped on Revive`);
        }
      },
    },
  );
  if (result && !result.ok) {
    throw new Error(
      `Revive.map_account failed: ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }
}

let runtime: ContractRuntime | null = null;
async function getRuntime(): Promise<ContractRuntime> {
  if (!runtime) {
    const api = await getTestClient();
    runtime = createContractRuntimeFromClient(api.raw.assetHub, paseo_asset_hub);
  }
  return runtime;
}

/**
 * Publish a domain with the given metadata. Signs with the SIGNER.
 *
 * Returns the metadata CID after the tx is included AND queryable. Closes
 * the Bulletin client on the way out so it doesn't leak into globalTeardown.
 */
export async function publishDomain(
  domain: string,
  metadata: Record<string, unknown>,
  visibility: number = VISIBILITY_PUBLIC,
): Promise<string> {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const metadataCid = (await calculateCid(metadataBytes)).toString();

  const acct = getSignerKeypair();
  const bulletin = await CloudStorageClient.create({ environment: PRODUCT_SDK_ENV, signer: acct.signer });
  try {
    // store(...).send() submits a signed `TransactionStorage.store` extrinsic
    // and requires the signer to be authorized on the Bulletin Chain
    // (`TransactionStorage.Authorizations`). The legacy `batchUpload` API
    // wrapped a similar flow. If this throws with an authorization error in
    // CI, the funder needs a one-time `bulletin.authorizeAccount(...)` call —
    // see @parity/product-sdk-cloud-storage's `checkAuthorization` helper for a
    // pre-flight check.
    await bulletin.store(metadataBytes).send();
  } finally {
    // CloudStorageClient holds a WebSocket that keeps the Node event loop alive.
    // Always release it, even on upload failure.
    await bulletin.destroy();
  }

  const registry = await getRegistry();
  const result = await registry.publish.tx(domain, metadataCid, visibility);
  if (!result.ok) {
    throw new Error(
      `registry.publish failed: ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }

  // The tx was included, but block finalization + indexer state catch-up
  // means the iframe's first read might not see the row yet. Block here
  // until getApp confirms the entry is queryable, so callers can safely
  // proceed to read tests immediately after.
  await waitForApp(domain, 30_000);

  return metadataCid;
}

/** Compute the metadata CID for the given object (without uploading). */
export async function computeMetadataCid(metadata: Record<string, unknown>): Promise<string> {
  return (await calculateCid(new TextEncoder().encode(JSON.stringify(metadata)))).toString();
}

/**
 * Unpublish a domain. Used by write tests to clean up throwaway domains so
 * the registry doesn't accumulate stale e2e-* entries on every run.
 *
 * Best-effort: failures are logged, not thrown — cleanup must not mask the
 * actual test failure.
 */
export async function unpublishDomain(domain: string): Promise<void> {
  try {
    const registry = await getRegistry();
    const result = await registry.unpublish.tx(domain);
    if (!result.ok) {
      console.warn(
        `[e2e cleanup] unpublish '${domain}' failed: ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
      );
    }
  } catch (err) {
    console.warn(`[e2e cleanup] unpublish '${domain}' threw: ${err}`);
  }
}

function domainToEntity(domain: string): Uint8Array {
  return keccak256(utf8ToBytes(domain));
}

export interface RatingMetrics {
  average: number;
  count: number;
}

let _contextId: Uint8Array | null = null;
async function getContextId(): Promise<Uint8Array> {
  if (_contextId) return _contextId;
  const registry = await getRegistry();
  const res = await registry.getContextId.query();
  if (!res.success) throw new Error("Failed to get context ID");
  _contextId = res.value as Uint8Array;
  return _contextId;
}

export async function getRatingMetrics(domain: string): Promise<RatingMetrics | null> {
  try {
    const reputation = await getReputation();
    const contextId = await getContextId();
    const res = await reputation.getMetrics.query(contextId, domainToEntity(domain));
    if (!res.success) return null;
    return { average: res.value.average, count: Number(res.value.count) };
  } catch {
    return null;
  }
}

/**
 * Read the SIGNER's existing rating for a domain. Returns 0 when the SIGNER
 * has not rated, or 1-5 when they have. Lets tests distinguish "the signer
 * has already rated" from "someone else has rated", which the aggregate
 * `getRatingMetrics` count cannot.
 */
export async function getSignerRating(domain: string): Promise<number> {
  try {
    const reputation = await getReputation();
    const contextId = await getContextId();
    const res = await reputation.getRating.query(
      contextId,
      SIGNER.h160,
      domainToEntity(domain),
    );
    if (!res.success) return 0;
    return Number(res.value);
  } catch {
    return 0;
  }
}
