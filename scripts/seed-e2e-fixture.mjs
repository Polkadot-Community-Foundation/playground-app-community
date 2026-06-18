// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * One-time seed: publish the e2e fixture domain on Paseo Asset Hub Next.
 *
 * Why this exists: paritytech/product-sdk#94 makes the SDK's
 * `CloudStorageClient.create({ environment, signer })` unusable from Node —
 * it routes through `@novasamatech/host-api`'s `getHostProvider` which
 * only works inside a Polkadot Desktop/Mobile host. The e2e suite's
 * `globalSetup()` hits this when it tries to publish the fixture for
 * the first time on a fresh chain.
 *
 * This script bypasses the broken wrapper by constructing the lower-
 * level `AsyncBulletinClient` directly from `@parity/bulletin-sdk` and
 * `polkadot-api`. After this runs once, `setup.ts` finds the fixture
 * via `getApp(domain)` (a read-only path that works in Node) and uses
 * the happy path — no SDK#94 dependency. When the chain wipes / a fresh
 * deploy lands, run this once again (or, if SDK#94 has shipped by then,
 * the regular `publishDomain` path will resume working automatically).
 *
 * Usage:
 *   E2E_FUNDER_SEED='<mnemonic>' pnpm tsx scripts/seed-e2e-fixture.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { seedToAccount } from "@parity/product-sdk-keys";
// AsyncBulletinClient + calculateCid are re-exported from product-sdk-cloud-storage
// (which in turn re-exports them from @parity/bulletin-sdk). Importing the
// symbols only — never calling CloudStorageClient.create — keeps us off the
// host-routed code path that fails in Node (paritytech/product-sdk#94).
import {
  AsyncBulletinClient,
  calculateCid,
} from "@parity/product-sdk-cloud-storage";
import {
  createContract,
  createContractRuntimeFromClient,
} from "@parity/product-sdk-contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ───────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────

const FIXTURE_DOMAIN = "playground-e2e-app.dot";
const VISIBILITY_PUBLIC = 1;

const cdm = JSON.parse(readFileSync(join(REPO_ROOT, "cdm.json"), "utf-8"));

// Asset-Hub RPC for the Paseo Next v2 deployment. Override via
// ASSET_HUB_WS_URL for one-off runs against a custom RPC.
const ASSET_HUB_RPC =
  process.env.ASSET_HUB_WS_URL ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";

// Bulletin Next V2 endpoint per paritytech/product-sdk#77.
const BULLETIN_RPC = "wss://paseo-bulletin-next-rpc.polkadot.io";

const fixtureMetadata = JSON.parse(
  readFileSync(join(REPO_ROOT, "e2e/fixture-metadata.json"), "utf-8"),
);

// ───────────────────────────────────────────────────────────────────
// Funder keypair (empty-path derivation — matches e2e/accounts.ts + the
// dotNS CLI + personhood-faucet defaults)
// ───────────────────────────────────────────────────────────────────

const mnemonic = process.env.E2E_FUNDER_SEED;
if (!mnemonic) {
  console.error(
    "ERROR: set E2E_FUNDER_SEED to the funder mnemonic before running.\n" +
      "  E2E_FUNDER_SEED='<mnemonic>' pnpm tsx scripts/seed-e2e-fixture.mjs",
  );
  process.exit(1);
}
const funder = seedToAccount(mnemonic, "");

console.log(`[seed] Funder: ${funder.ss58Address} / ${funder.h160Address}`);
console.log(`[seed] Fixture domain: ${FIXTURE_DOMAIN}`);
console.log(`[seed] Asset Hub: ${ASSET_HUB_RPC}`);
console.log(`[seed] Bulletin:  ${BULLETIN_RPC}`);

// ───────────────────────────────────────────────────────────────────
// 1. Compute the metadata CID
// ───────────────────────────────────────────────────────────────────

const metadataBytes = new TextEncoder().encode(JSON.stringify(fixtureMetadata));
const cid = (await calculateCid(metadataBytes)).toString();
console.log(`[seed] Metadata bytes: ${metadataBytes.length}`);
console.log(`[seed] Metadata CID:   ${cid}`);

// ───────────────────────────────────────────────────────────────────
// 2. Upload metadata to Bulletin Next via @parity/bulletin-sdk directly
//    (bypasses the SDK#94-broken `BulletinClient.create` wrapper)
// ───────────────────────────────────────────────────────────────────

console.log(`[seed] Connecting to Bulletin Next…`);
const bulletinClient = createClient(getWsProvider(BULLETIN_RPC));
const bulletinApi = bulletinClient.getTypedApi(paseo_bulletin);

try {
  const inner = new AsyncBulletinClient(
    bulletinApi,
    funder.signer,
    bulletinClient.submit,
  );

  console.log(`[seed] Storing metadata on Bulletin Next…`);
  const storeResult = await inner.store(metadataBytes).send();
  console.log(`[seed]   tx hash: ${storeResult.txHash ?? "(included)"}`);
  console.log(`[seed]   stored CID: ${(storeResult.cid ?? cid).toString()}`);
} catch (err) {
  console.error(`[seed] Bulletin upload failed:`, err);
  bulletinClient.destroy();
  process.exit(1);
}

bulletinClient.destroy();

// ───────────────────────────────────────────────────────────────────
// 3. Publish to the playground registry on Asset Hub Next
// ───────────────────────────────────────────────────────────────────

console.log(`[seed] Connecting to Asset Hub Next…`);
const assetHubClient = createClient(getWsProvider(ASSET_HUB_RPC));

try {
  const runtime = createContractRuntimeFromClient(assetHubClient, paseo_asset_hub);

  const registryEntry = cdm.contracts["@w3s/playground-registry"];
  if (!registryEntry) throw new Error("Registry contract missing from cdm.json");

  const registry = createContract(runtime, registryEntry.address, registryEntry.abi);

  console.log(`[seed] Calling registry.publish(${FIXTURE_DOMAIN}, ${cid}, PUBLIC)…`);
  // publish() is a 7-arg ABI (owner/modded_from/is_moddable/is_dev_signer were
  // added for the modding + scoring work). Mirror src/App.tsx's call shape:
  //   owner: None  → contract defaults owner to the caller (the funder)
  //   modded_from: "" → fixture is not a mod
  const txResult = await registry.publish.tx(
    FIXTURE_DOMAIN,
    cid,
    VISIBILITY_PUBLIC,
    { isSome: false, value: "0x0000000000000000000000000000000000000000" },
    "",
    false,
    false,
    { signer: funder.signer, origin: funder.ss58Address },
  );

  if (!txResult.ok) {
    console.error(`[seed] registry.publish failed:`, txResult);
    assetHubClient.destroy();
    process.exit(1);
  }

  console.log(`[seed]   tx hash: ${txResult.txHash}`);

  // Verify by reading back
  console.log(`[seed] Verifying via getMetadataUri…`);
  const verify = await registry.getMetadataUri.query(FIXTURE_DOMAIN);
  if (verify.success && verify.value?.isSome) {
    console.log(`[seed]   ✓ on-chain CID: ${verify.value.value}`);
    if (verify.value.value !== cid) {
      console.warn(`[seed]   ⚠ on-chain CID differs from what we just published!`);
    }
  } else {
    console.warn(`[seed]   getMetadataUri did not return the fixture (transient indexer lag?)`);
  }
} catch (err) {
  console.error(`[seed] Registry publish failed:`, err);
  assetHubClient.destroy();
  process.exit(1);
}

assetHubClient.destroy();

console.log(`[seed] ✓ Fixture seeded. e2e setup.ts will find it on next run.`);
process.exit(0);
