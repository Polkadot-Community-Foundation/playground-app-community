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
 * Publishes playground registry metadata from package.json fields.
 *
 * Reads playground:* fields, uploads icon + metadata JSON to Bulletin,
 * and calls registry.publish() on-chain.
 *
 * Usage: tsx scripts/publish-metadata.ts <domain.dot>
 * Env:   MNEMONIC — sr25519 mnemonic for signing
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { calculateCid } from "@parity/product-sdk-cloud-storage";
import { AsyncBulletinClient } from "@parity/bulletin-sdk";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import cdmJson from "../cdm.json" with { type: "json" };
import pkg from "../package.json";
import { PLAYGROUND_REGISTRY_CONTRACT } from "../src/utils/contractManifest.ts";
import { assetHubWsUrl } from "./_lib.ts";

// Paseo Next v2 Bulletin chain WS endpoint. cdm.json's `bulletin` field is
// the IPFS gateway URL (https), not the chain WS — and `BULLETIN_RPCS` from
// `@parity/product-sdk-host` isn't a direct dep here, so it's hardcoded.
const BULLETIN_WS_URL = "wss://paseo-bulletin-next-rpc.polkadot.io";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Args & env
// ---------------------------------------------------------------------------

const domain = process.argv[2];
if (!domain) {
  console.error("Usage: tsx scripts/publish-metadata.ts <domain.dot>");
  process.exit(1);
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  console.error("MNEMONIC env var required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Signer (same derivation as bulletin-deploy)
// ---------------------------------------------------------------------------

const { signer, ss58Address: origin } = seedToAccount(mnemonic, "");

// ---------------------------------------------------------------------------
// Metadata from package.json
// ---------------------------------------------------------------------------

const description = (pkg as Record<string, unknown>)["playground:description"] as string | undefined;
const tag = (pkg as Record<string, unknown>)["playground:tag"] as string | undefined;
const iconPath = (pkg as Record<string, unknown>)["playground:icon"] as string | undefined;

function gitRemoteUrl(): string | undefined {
  try {
    const raw = execSync("git remote get-url origin", { encoding: "utf-8", stdio: "pipe" }).trim();
    return raw.startsWith("git@")
      ? raw.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "")
      : raw.replace(/\.git$/, "");
  } catch {
    return undefined;
  }
}

// Build upload items
const uploads: { label: string; bytes: Uint8Array }[] = [];
let iconCid: string | undefined;
if (iconPath) {
  const abs = resolve(root, iconPath);
  if (existsSync(abs)) {
    const iconBytes = new Uint8Array(readFileSync(abs));
    iconCid = (await calculateCid(iconBytes)).toString();
    uploads.push({ label: "icon", bytes: iconBytes });
    console.log(`Icon: ${abs} -> ${iconCid}`);
  } else {
    console.warn(`Icon not found at ${abs}, skipping`);
  }
}

const readmePath = resolve(root, "README.md");
const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf-8") : undefined;
if (readme) console.log(`Readme: ${readmePath} (${readme.length} chars)`);

const metadata = {
  ...(pkg.name && { name: pkg.name }),
  ...(description && { description }),
  ...(gitRemoteUrl() && { repository: gitRemoteUrl() }),
  ...(iconCid && { icon_cid: iconCid }),
  ...(tag && { tag }),
  ...(readme && { readme }),
};

const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
const metadataCid = (await calculateCid(metadataBytes)).toString();
uploads.push({ label: "metadata", bytes: metadataBytes });

console.log("Metadata:", JSON.stringify(metadata, null, 2));
console.log("CID:", metadataCid);

// ---------------------------------------------------------------------------
// Upload to Bulletin (per-item store(...).send() — no atomic batch in 0.1.0)
// ---------------------------------------------------------------------------

// `CloudStorageClient.create` routes through chain-client's `createChainClient`,
// which is host-only. Wire `AsyncBulletinClient` (the upstream upload primitive)
// directly against a plain WS PolkadotClient so this works under Node.
console.log("Uploading to Bulletin...");
const bulletinClient = createClient(getWsProvider(BULLETIN_WS_URL));
const bulletinApi = bulletinClient.getTypedApi(paseo_bulletin);
// bulletin-sdk@0.3.0 was built against pre-refresh paseo-bulletin metadata where `renew` took
// `{ block, index }`; the new descriptor wraps it as `{ entry: Enum<Position|ContentHash> }`.
// This script only calls `store()`, never `renew`, so the structural mismatch is safe to widen.
const bulletinUploader = new AsyncBulletinClient(bulletinApi as never, signer, bulletinClient.submit);
for (const { label, bytes } of uploads) {
  console.log(`  ${label} (${bytes.length} bytes)...`);
  await bulletinUploader.store(bytes).send();
}
bulletinClient.destroy();
console.log("Upload complete");

// ---------------------------------------------------------------------------
// Publish to registry
// ---------------------------------------------------------------------------

// Node script: wire the chain client directly. chain-client@0.4.x is
// host-only (Polkadot Browser/Desktop) and has no WS fallback for Node.
const chainClient = createClient(getWsProvider(assetHubWsUrl()));

const manager = await ContractManager.fromLiveClient(
  cdmJson as unknown as CdmJson,
  chainClient,
  paseo_asset_hub,
  {
    defaultSigner: signer,
    defaultOrigin: origin,
    registryOrigin: origin,
    libraries: [PLAYGROUND_REGISTRY_CONTRACT],
  },
);

try {
  const registry = manager.getContract(PLAYGROUND_REGISTRY_CONTRACT);
  console.log(`Registry: ${PLAYGROUND_REGISTRY_CONTRACT} (${manager.getAddress(PLAYGROUND_REGISTRY_CONTRACT)})`);
  console.log(`Publishing ${domain} as ${origin}...`);
  const result = await registry.publish.tx(
    domain,
    metadataCid,
    1,
    { isSome: false, value: "0x0000000000000000000000000000000000000000" as const },
    // modded_from is plain `string` on the contract — "" = no mod source.
    // See contracts/registry/lib.rs comment on the param.
    "",
    false,
    // is_dev_signer is retained for ABI compatibility but ignored by the
    // contract. Use a blacklisted/dedicated signer, private visibility, or
    // `publish_dev` with the known dev signer when this publish must not score.
    false,
  );
  if (!result.ok) throw new Error("Registry publish transaction failed");
  console.log(`Tx: ${result.txHash}`);
  console.log(`Published ${domain}!`);
} finally {
  chainClient.destroy();
  process.exit(0);
}
