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
 * Submit a tiny Balances.transferKeepAlive from the product account to acc_old
 * via local signing. Used to confirm that substrate-side fee-payment works for
 * the product account once mapping is in place — isolating whether the SSO
 * sign flow's failures are a host-papp / Mobile bug (this script succeeds) vs.
 * a chain-side block (this script also fails).
 *
 * Usage:
 *   MNEMONIC="<wallet seed>" pnpm tsx scripts/test-tx.ts <dotNsId> <recipientSS58>
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58Address as encodeSs58 } from "@polkadot-labs/hdkd-helpers";
import { sign as sr25519Sign } from "@scure/sr25519";
import { getPolkadotSigner } from "polkadot-api/signer";
import { assetHubWsUrl, deriveProductAccount } from "./_lib.ts";

const dotNsId = process.argv[2];
const recipient = process.argv[3];
const mnemonic = process.env.MNEMONIC;

if (!dotNsId || !recipient || !mnemonic) {
  console.error("Usage: MNEMONIC=... pnpm tsx scripts/test-tx.ts <dotNsId> <recipientSS58>");
  process.exit(1);
}

const { productSecret, productPublic } = deriveProductAccount(mnemonic, dotNsId);
const ss58 = encodeSs58(productPublic);

console.log("Sender (product account):", ss58);
console.log("Recipient:               ", recipient);
console.log();

const signer = getPolkadotSigner(productPublic, "Sr25519", (data) => sr25519Sign(productSecret, data));

const client = createClient(getWsProvider(assetHubWsUrl()));
const api = client.getTypedApi(paseo_asset_hub);

let exitCode = 0;
try {
  const dest = { type: "Id" as const, value: recipient };
  const value = 1_000_000n; // 0.0000001 PAS — minimum-meaningful test
  console.log("Submitting transfer_keep_alive...");
  const result = await api.tx.Balances.transfer_keep_alive({ dest, value }).signAndSubmit(signer);
  console.log("Result: ok=", result.ok, "txHash=", result.txHash, "block=", result.block?.number);
  if (!result.ok) {
    console.log("dispatchError:", JSON.stringify(result.dispatchError, (_, v) =>
      typeof v === "bigint" ? v.toString() : v, 2));
    exitCode = 1;
  }
} catch (err) {
  console.error("Submission threw:", err);
  exitCode = 1;
} finally {
  client.destroy();
  process.exit(exitCode);
}
