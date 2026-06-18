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
 * Seeds the points-blacklist on the playground registry. Blacklisted accounts
 * silently no-op out of `award_points`, so they can never appear on the
 * leaderboard. On a fresh deploy this must be run once to scrub the well-known
 * dev/test signers; the migration (`import-registry-state.ts`) seeds the same
 * set automatically as its step 0, so a migrated registry needs nothing here.
 *
 * With no args, blacklists the well-known DEV_ACCOUNTS. Pass extra H160 or SS58
 * addresses to blacklist them too. Idempotent — re-running is a cheap no-op.
 *
 * Usage: tsx scripts/blacklist-accounts.ts [ADDRESS ...]
 * Env:   MNEMONIC — sr25519 mnemonic for the sudo/admin account
 *        CHAIN    — target network (paseo | summit); default paseo
 *
 * Example (resolving the sudo mnemonic from the local cdm config):
 *   MNEMONIC="$(node -e "process.stdout.write(require(require('os').homedir()+'/.cdm/accounts.json').paseo.mnemonic)")" \
 *     pnpm tsx scripts/blacklist-accounts.ts
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
import { assetHubDescriptor, assetHubWsUrl, DEV_ACCOUNTS, resolveChain } from "./_lib.ts";

const REGISTRY_CONTRACT = PLAYGROUND_REGISTRY_CONTRACT;

// ---------------------------------------------------------------------------
// Args & env
// ---------------------------------------------------------------------------

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  console.error("MNEMONIC env var required (sudo/admin account)");
  process.exit(1);
}

// Extra addresses (H160 or SS58) accepted on the command line; default set is
// the well-known dev/test accounts. Normalise everything to lowercased H160.
const extra = process.argv.slice(2).map((a) =>
  a.startsWith("0x") ? a.toLowerCase() : ss58ToH160(a).toLowerCase(),
);
const targets = [...new Set([...DEV_ACCOUNTS, ...extra].map((a) => a.toLowerCase()))];

// ---------------------------------------------------------------------------
// Signer & target
// ---------------------------------------------------------------------------

const { signer, ss58Address: origin } = seedToAccount(mnemonic, "");
const chain = resolveChain();

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

// Node script: wire the chain client directly. chain-client@0.4.x is
// host-only (Polkadot Browser/Desktop) and has no WS fallback for Node.
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
  console.log(`Chain: ${chain}`);
  console.log(`Contract: ${REGISTRY_CONTRACT} (${contractAddress})`);
  console.log(`Caller: ${origin} (${ss58ToH160(origin)})`);
  console.log(`Blacklisting ${targets.length} account(s):`);
  for (const t of targets) console.log(`  ${t}`);

  const result = await registry.setBlacklisted.tx(targets, true);
  if (!result.ok) throw new Error("setBlacklisted transaction failed");
  console.log(`Tx: ${result.txHash}`);

  // Verify in parallel — the reads are independent, so a serial loop would
  // just stack chain round-trips.
  const verifications = await Promise.all(targets.map((t) => registry.isBlacklisted.query(t)));
  verifications.forEach((res, i) => {
    console.log(`isBlacklisted ${targets[i]}: ${res.success ? res.value : "query failed"}`);
  });
} finally {
  client.destroy();
  process.exit(0);
}
