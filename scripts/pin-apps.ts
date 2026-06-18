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
 * Pins one or more app domains on the playground registry contract.
 *
 * Usage: tsx scripts/pin-apps.ts <domain> [<domain> ...]
 * Env:   MNEMONIC — sr25519 mnemonic for a sudo or admin account
 *        CHAIN    — target network (paseo | summit); default paseo
 *
 * Pinning makes an app render at the top of the Apps grid in the
 * playground-app frontend. The canonical pin set is the structured
 * tutorial, the sample apps, and the empty/starter template.
 *
 * Idempotent — already-pinned domains are skipped. Domains that haven't
 * been `publish`'d yet fail with `AppNotFound`; pin them after the app
 * appears in the registry.
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { ss58ToH160 } from "@parity/product-sdk-address";
import cdmJson from "../cdm.json" with { type: "json" };
import { PLAYGROUND_REGISTRY_CONTRACT } from "../src/utils/contractManifest.ts";
import { assetHubDescriptor, assetHubWsUrl, resolveChain } from "./_lib.ts";

const REGISTRY_CONTRACT = PLAYGROUND_REGISTRY_CONTRACT;

// ---------------------------------------------------------------------------
// Args & env
// ---------------------------------------------------------------------------

const domains = process.argv.slice(2);
if (domains.length === 0) {
  console.error("Usage: tsx scripts/pin-apps.ts <domain> [<domain> ...]");
  process.exit(1);
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  console.error("MNEMONIC env var required (sudo or admin account)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

const { signer, ss58Address: origin } = seedToAccount(mnemonic, "");
const chain = resolveChain();

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const client = createClient(getWsProvider(assetHubWsUrl(chain)));

const manager = await ContractManager.fromLiveClient(
  cdmJson as unknown as CdmJson,
  client,
  assetHubDescriptor(chain),
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
  console.log(`Chain:    ${chain}`);
  console.log(`Contract: ${REGISTRY_CONTRACT} (${contractAddress})`);
  console.log(`Caller:   ${origin} (${ss58ToH160(origin)})`);
  console.log(`Pinning ${domains.length} domain(s)...\n`);

  let pinned = 0;
  let skipped = 0;

  for (const domain of domains) {
    const isPinnedRes = await registry.isPinned.query(domain);
    if (isPinnedRes.success && isPinnedRes.value) {
      console.log(`  [skip] ${domain} — already pinned`);
      skipped++;
      continue;
    }

    process.stdout.write(`  pin   ${domain} ... `);
    const result = await registry.pin.tx(domain);
    if (!result.ok) {
      console.log(`FAILED`);
      throw new Error(`pin(${domain}) transaction failed`);
    }
    console.log(`ok (${result.txHash})`);
    pinned++;
  }

  console.log(`\nDone — pinned ${pinned}, skipped ${skipped}.`);
} finally {
  client.destroy();
  process.exit(0);
}
