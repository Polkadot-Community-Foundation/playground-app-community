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
 * Unpublish stale e2e fixture entries from the playground registry.
 *
 * The e2e suite's throwaway-fixture cleanup (`unpublishDomain` in
 * `e2e/registry.ts`) swallows failures into a `console.warn`, so when the
 * teardown unpublish silently fails — as it does on current main while a
 * `@parity/product-sdk-descriptors` regen is pending — fixture entries
 * accumulate on the public grid across test runs. This script is the manual
 * cleanup until the in-suite teardown is reliable again.
 *
 * Pages through `registry.getApps`, filters to entries owned by the funder
 * with a known fixture name, and unpublishes them.
 *
 * Usage:
 *   E2E_FUNDER_SEED="<mnemonic>" tsx scripts/cleanup-e2e-leaks.ts            # dry-run
 *   E2E_FUNDER_SEED="<mnemonic>" tsx scripts/cleanup-e2e-leaks.ts --apply    # actually unpublish
 *   ... --name "E2E Live Event"                                              # override target name
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { assetHubWsUrl } from "./_lib.ts";
import { PLAYGROUND_REGISTRY_CONTRACT } from "../src/utils/contractManifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cdmJson = JSON.parse(readFileSync(resolve(root, "cdm.json"), "utf-8")) as CdmJson;

// Bulletin IPFS gateway is no longer stored in cdm.json (flat-manifest
// migration). Pinned to the Paseo Next v2 gateway that matches `-n paseo`;
// override with BULLETIN_GATEWAY_URL for one-off runs against a custom one.
const BULLETIN_GATEWAY_URL =
  process.env.BULLETIN_GATEWAY_URL ?? "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const nameIdx = args.indexOf("--name");
const targetName = nameIdx >= 0 ? args[nameIdx + 1] : "E2E Visibility Target";

const seed = process.env.E2E_FUNDER_SEED;
if (!seed) {
  console.error("E2E_FUNDER_SEED env var required (the funder that owns the leaks)");
  process.exit(1);
}

const { signer, ss58Address: origin, h160Address } = seedToAccount(seed, "");
const funderH160 = h160Address.toLowerCase();
console.log(`Funder ss58: ${origin}`);
console.log(`Funder h160: ${funderH160}`);
console.log(`Target name: "${targetName}"`);
console.log(`Mode:        ${apply ? "APPLY (will unpublish)" : "DRY-RUN"}`);
console.log();

// The @parity/product-sdk-cloud-storage fetchJson is host-only — routed
// through the Polkadot host's preimage subscription — so a Node-side script
// must hit the gateway directly.
const gateway = BULLETIN_GATEWAY_URL.replace(/\/$/, "");

async function fetchMetadata<T>(cid: string): Promise<T> {
  const res = await fetch(`${gateway}/${cid}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${cid}`);
  return (await res.json()) as T;
}

// chain-client@0.4.x requires a Polkadot Browser/Desktop host with no
// WebSocket fallback; node scripts wire the PolkadotClient directly.
const chainClient = createClient(getWsProvider(assetHubWsUrl()));

const manager = await ContractManager.fromLiveClient(cdmJson, chainClient, paseo_asset_hub, {
  defaultSigner: signer,
  defaultOrigin: origin,
  registryOrigin: origin,
  libraries: [PLAYGROUND_REGISTRY_CONTRACT],
});
const registry = manager.getContract(PLAYGROUND_REGISTRY_CONTRACT);

const PAGE = 50;
const matches: { domain: string; name: string }[] = [];
let offset = 0;
let scannedTotal = 0;
let total = -1;

while (true) {
  const r = await registry.getApps.query(offset, PAGE);
  if (!r.success) {
    console.error(`getApps(offset=${offset}) failed:`, r);
    break;
  }
  if (total < 0) total = Number(r.value.total);
  const entries = (r.value.entries ?? []) as { domain: string; metadata_uri: string; owner: unknown }[];
  const scanned = Number(r.value.scanned ?? entries.length);
  scannedTotal += scanned;

  const ours = entries.filter((e) => String(e.owner).toLowerCase() === funderH160);
  for (const e of ours) {
    try {
      const metadata = await fetchMetadata<{ name?: string }>(e.metadata_uri);
      if (metadata?.name === targetName) {
        matches.push({ domain: e.domain, name: metadata.name });
        console.log(`MATCH  ${e.domain}  (${metadata.name})`);
      }
    } catch (err) {
      console.warn(`fetch metadata for ${e.domain} (${e.metadata_uri}) failed: ${err}`);
    }
  }

  if (entries.length === 0 || scanned === 0) break;
  offset += scanned;
  if (total >= 0 && offset >= total) break;
}

console.log();
console.log(`Scanned ${scannedTotal} slots; ${matches.length} match(es) for "${targetName}".`);

if (!apply) {
  console.log("Dry-run — re-run with --apply to unpublish.");
  chainClient.destroy();
  process.exit(0);
}

let okCount = 0;
let failCount = 0;
for (const { domain } of matches) {
  try {
    const result = await registry.unpublish.tx(domain);
    if (result.ok) {
      console.log(`unpublished ${domain}`);
      okCount++;
    } else {
      console.warn(`unpublish ${domain} failed:`, result);
      failCount++;
    }
  } catch (err) {
    console.warn(`unpublish ${domain} threw: ${err}`);
    failCount++;
  }
}

console.log();
console.log(`Done. ${okCount} unpublished, ${failCount} failed.`);
chainClient.destroy();
process.exit(failCount > 0 ? 1 : 0);
