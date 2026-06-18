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
 * Check whether a playground product account is mapped in pallet-revive on
 * Paseo Asset Hub, and dump its on-chain balance.
 *
 * Two modes:
 *
 * 1. Direct address — pass the SS58 (or `0x`-prefixed H160) you already have
 *    from the in-app signin log. No mnemonic needed.
 *
 *      pnpm tsx scripts/check-revive-mapping.ts 5CvkCffkvNXK6RzGjkpPnf7dqqU55QA2HS97yHz7WPUbL8P4
 *
 * 2. Derive — replicate Desktop's product-account derivation
 *    (junctions: `product`, `<dotNsIdentifier>`, `0`) from a wallet mnemonic.
 *    Useful for cross-checking that a given mnemonic + identifier produces the
 *    address Desktop is signing as. Requires the *Desktop wallet* mnemonic,
 *    not a CDM CLI key.
 *
 *      MNEMONIC="<seed phrase>" pnpm tsx scripts/check-revive-mapping.ts --derive localhost:5173
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58Address as encodeSs58, ss58Decode } from "@polkadot-labs/hdkd-helpers";
import { deriveH160, h160ToSs58 } from "@parity/product-sdk-address";
import { assetHubWsUrl, deriveProductAccount } from "./_lib.ts";

// ---------------------------------------------------------------------------
// Resolve target address from CLI args.
// ---------------------------------------------------------------------------

let ss58: string;
let h160: `0x${string}`;
let label: string;

const arg1 = process.argv[2];
if (arg1 === "--derive") {
  const dotNsId = process.argv[3] ?? "playground.dot";
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error("MNEMONIC env var required for --derive mode");
    process.exit(1);
  }
  const { barePublic, walletPublic, productPublic } = deriveProductAccount(mnemonic, dotNsId);
  console.log("Bare master (no junctions)");
  console.log("  SS58:       ", encodeSs58(barePublic));
  console.log();
  console.log("Mobile wallet account (//wallet hard junction)");
  console.log("  SS58:       ", encodeSs58(walletPublic));
  console.log();
  ss58 = encodeSs58(productPublic);
  h160 = deriveH160(productPublic);
  label = `product-account derived from //wallet + product/${dotNsId}/0`;
} else if (arg1?.startsWith("0x")) {
  h160 = arg1 as `0x${string}`;
  ss58 = h160ToSs58(h160);
  label = "from H160 input";
} else if (arg1) {
  ss58 = arg1;
  // Accept the address but skip H160 derivation since we'd need the public key
  // for that — the SS58 → H160 mapping is what the chain stores, not derives.
  const decoded = ss58Decode(ss58);
  h160 = deriveH160(decoded[0]);
  label = "from SS58 input";
} else {
  console.error("Usage:");
  console.error("  pnpm tsx scripts/check-revive-mapping.ts <SS58 | 0xH160>");
  console.error("  MNEMONIC=... pnpm tsx scripts/check-revive-mapping.ts --derive <dotNsId>");
  process.exit(1);
}

console.log("Target", `(${label})`);
console.log("  SS58:       ", ss58);
console.log("  H160:       ", h160);
console.log();

const wsUrl = assetHubWsUrl();
console.log("Connecting to", wsUrl);
const client = createClient(getWsProvider(wsUrl));
const api = client.getTypedApi(paseo_asset_hub);

try {
  const sysAccount = await api.query.System.Account.getValue(ss58);
  console.log();
  console.log("System.Account[SS58]");
  console.log("  free:       ", sysAccount.data.free.toString());
  console.log("  reserved:   ", sysAccount.data.reserved.toString());
  console.log("  nonce:      ", sysAccount.nonce);

  const reviveInfo = await api.query.Revive.AccountInfoOf.getValue(h160 as `0x${string}`);
  console.log();
  console.log("Revive.AccountInfoOf[H160]");
  if (reviveInfo) {
    console.log("  account_type:", reviveInfo.account_type?.type ?? "<unknown>");
  } else {
    console.log("  <null — H160 has no pallet-revive account record yet>");
  }

  const mapped = await api.query.Revive.OriginalAccount.getValue(h160 as `0x${string}`);
  console.log();
  console.log("Revive.OriginalAccount[H160]  (SS58 ↔ H160 mapping)");
  if (mapped) {
    console.log("  →", mapped);
    // Compare by underlying public key, not encoded SS58: Asset Hub stores
    // with prefix 0 (Polkadot), our default ss58Address encodes with prefix 42.
    // Same pubkey, different string.
    const mappedDecoded = ss58Decode(mapped);
    const expectedDecoded = ss58Decode(ss58);
    const same = mappedDecoded[0].length === expectedDecoded[0].length &&
      mappedDecoded[0].every((b, i) => b === expectedDecoded[0][i]);
    console.log(
      "  matches expected pubkey:",
      same ? "yes ✓" : `no — expected ${ss58}`,
    );
  } else {
    console.log("  <null — NOT MAPPED>");
    console.log("  Run Revive.map_account() signed by this SS58 to register the binding,");
    console.log("  or pallet-revive eth_call dry-runs against this H160 will see a 0-balance");
    console.log("  account and fail validation with InvalidTransaction::Payment.");
  }
} finally {
  client.destroy();
  process.exit(0);
}
