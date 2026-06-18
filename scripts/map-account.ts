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
 * Submit Revive.map_account() from the same product-derived keypair the host
 * uses, bypassing the SSO/host-papp signing flow. Used to test whether the
 * substrate-side fee-payment failure (InvalidTransaction::Payment) we hit when
 * Mobile signs is reproducible with a local signer too — if it isn't, the
 * issue is in the SSO sign path.
 *
 * Usage:
 *   MNEMONIC="<wallet seed>" pnpm tsx scripts/map-account.ts <dotNsId>
 *
 * The dotNsId must be the identifier the host registered the product under
 * (e.g. "localhost:5173" for dev, "playground.dot" for the deployed app).
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58Address as encodeSs58 } from "@polkadot-labs/hdkd-helpers";
import { sign as sr25519Sign } from "@scure/sr25519";
import { getPolkadotSigner } from "polkadot-api/signer";
import { deriveH160 } from "@parity/product-sdk-address";
import { assetHubWsUrl, deriveProductAccount } from "./_lib.ts";

const dotNsId = process.argv[2];
const mnemonic = process.env.MNEMONIC;
if (!dotNsId) {
  console.error("Usage: MNEMONIC=... pnpm tsx scripts/map-account.ts <dotNsId>");
  process.exit(1);
}
if (!mnemonic) {
  console.error("MNEMONIC env var required");
  process.exit(1);
}

const { productSecret, productPublic } = deriveProductAccount(mnemonic, dotNsId);
const ss58 = encodeSs58(productPublic);
const h160 = deriveH160(productPublic);

console.log("Product account");
console.log("  SS58:", ss58);
console.log("  H160:", h160);
console.log();

const signer = getPolkadotSigner(productPublic, "Sr25519", (data) => sr25519Sign(productSecret, data));

const wsUrl = assetHubWsUrl();
console.log("Connecting to", wsUrl);
const client = createClient(getWsProvider(wsUrl));
const api = client.getTypedApi(paseo_asset_hub);

let exitCode = 0;
try {
  const existing = await api.query.Revive.OriginalAccount.getValue(h160 as `0x${string}`);
  if (existing) {
    console.log("Already mapped to:", existing);
  } else {
    console.log("Submitting Revive.map_account()...");
    const result = await api.tx.Revive.map_account().signAndSubmit(signer);
    console.log("Result: ok=", result.ok, "txHash=", result.txHash, "block=", result.block?.number);
    if (!result.ok) {
      console.log("dispatchError:", JSON.stringify(result.dispatchError, (_, v) =>
        typeof v === "bigint" ? v.toString() : v, 2));
      exitCode = 1;
    }
    console.log("events:");
    for (const evt of result.events) {
      console.log(`  ${evt.type}.${evt.value.type}`,
        JSON.stringify(evt.value.value, (_, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 200));
    }
  }
} catch (err) {
  console.error("Submission threw:", err);
  exitCode = 1;
} finally {
  client.destroy();
  process.exit(exitCode);
}
