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
 * Adds an SS58 address as an admin to the playground registry contract.
 *
 * Usage: tsx scripts/add-admin.ts <SS58_ADDRESS>
 * Env:   MNEMONIC — sr25519 mnemonic for the sudo account
 *
 * Example (resolving the sudo mnemonic from the local cdm config):
 *   MNEMONIC="$(node -e "process.stdout.write(require(require('os').homedir()+'/.cdm/accounts.json').paseo.mnemonic)")" \
 *     pnpm tsx scripts/add-admin.ts <SS58_ADDRESS>
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import cdmJson from "../cdm.json" with { type: "json" };
import { PLAYGROUND_REGISTRY_CONTRACT } from "../src/utils/contractManifest.ts";
import { assetHubWsUrl } from "./_lib.ts";

const REGISTRY_CONTRACT = PLAYGROUND_REGISTRY_CONTRACT;

// ---------------------------------------------------------------------------
// Args & env
// ---------------------------------------------------------------------------

const ss58Address = process.argv[2];
if (!ss58Address) {
  console.error("Usage: tsx scripts/add-admin.ts <SS58_ADDRESS>");
  process.exit(1);
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  console.error("MNEMONIC env var required (sudo account)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Signer & target
// ---------------------------------------------------------------------------

const { signer, ss58Address: origin } = seedToAccount(mnemonic, "");
const h160 = ss58ToH160(ss58Address);

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

// Node script: wire the chain client directly. chain-client@0.4.x is
// host-only (Polkadot Browser/Desktop) and has no WS fallback for Node.
const client = createClient(getWsProvider(assetHubWsUrl()));

const manager = await ContractManager.fromLiveClient(
  cdmJson as unknown as CdmJson,
  client,
  paseo_asset_hub,
  {
    defaultSigner: signer,
    defaultOrigin: origin,
    registryOrigin: origin,
    libraries: [REGISTRY_CONTRACT],
  },
);

try {
  const registry = manager.getContract(REGISTRY_CONTRACT);
  const contractAddress = manager.getAddress(REGISTRY_CONTRACT);
  console.log(`Contract: ${REGISTRY_CONTRACT} (${contractAddress})`);
  console.log(`Caller: ${origin} (${ss58ToH160(origin)})`);
  console.log(`Target: ${ss58Address} (${h160})`);

  const sudoRes = await registry.getSudo.query();
  console.log(`Sudo: ${sudoRes.success ? sudoRes.value : "unknown"}`);

  const beforeRes = await registry.isAdmin.query(h160);
  console.log(`isAdmin (before): ${beforeRes.success ? beforeRes.value : "query failed"}`);

  console.log(`Adding admin...`);
  const result = await registry.addAdmin.tx(h160);
  if (!result.ok) throw new Error("addAdmin transaction failed");
  console.log(`Tx: ${result.txHash}`);

  const afterRes = await registry.isAdmin.query(h160);
  console.log(`isAdmin (after): ${afterRes.success ? afterRes.value : "query failed"}`);
} finally {
  client.destroy();
  process.exit(0);
}
