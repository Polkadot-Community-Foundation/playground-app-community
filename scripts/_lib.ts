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
 * Shared helpers for the diagnostic scripts. Mirror Polkadot Mobile's
 * product-account derivation chain (`mnemonic → //wallet → product/<dotNsId>/0`)
 * and the chain-code encoding used by Polkadot Desktop's
 * `productAccountService.deriveProductPublicKey`.
 */

import {
  mnemonicToEntropy,
  entropyToMiniSecret,
  blake2b256,
} from "@polkadot-labs/hdkd-helpers";
import { secretFromSeed, getPublicKey, HDKD } from "@scure/sr25519";
import { str, u64 } from "scale-ts";

const JUNCTION_ID_LEN = 32;

// Numeric junctions are SCALE-encoded as u64 (8 bytes LE), strings as
// length-prefixed bytes, then padded to 32 — or blake2b-hashed if the
// encoding overflows. Differs from the Substrate URI standard (which encodes
// "/0" as a single byte), so we can't just hand the path to hdkd's URI parser.
export function createChainCode(code: string): Uint8Array {
  const encoded = /^\d+$/.test(code) ? u64.enc(BigInt(code)) : str.enc(code);
  if (encoded.length > JUNCTION_ID_LEN) return blake2b256(encoded);
  const out = new Uint8Array(JUNCTION_ID_LEN);
  out.set(encoded);
  return out;
}

export interface ProductDerivation {
  /** sr25519 secret bytes for the bare master keypair (mnemonic, no junctions). */
  bareSecret: Uint8Array;
  /** sr25519 secret bytes after the hard `//wallet` junction. */
  walletSecret: Uint8Array;
  /** sr25519 secret bytes for the product account; usable for signing. */
  productSecret: Uint8Array;
  /** 32-byte public key of the product account. */
  productPublic: Uint8Array;
  /** 32-byte public key of the bare master (handy for sanity-checking the mnemonic). */
  barePublic: Uint8Array;
  /** 32-byte public key of the //wallet account (what the host treats as `remoteAccount.accountId`). */
  walletPublic: Uint8Array;
}

/**
 * Replicate Polkadot Mobile's product-account derivation:
 *
 *   mnemonic → mini-secret
 *           → secretFromSeed (bare master)
 *           → secretHard("wallet")              (Mobile's main account)
 *           → secretSoft("product")             ┐
 *           → secretSoft(dotNsId)               ├ host-papp's product chain
 *           → secretSoft("0")                   ┘
 *           → product secret (sign-capable)
 */
export function deriveProductAccount(mnemonic: string, dotNsId: string): ProductDerivation {
  const entropy = mnemonicToEntropy(mnemonic);
  const miniSecret = entropyToMiniSecret(entropy);
  const bareSecret = secretFromSeed(miniSecret);
  const walletSecret = HDKD.secretHard(bareSecret, createChainCode("wallet"));
  const productSecret = ["product", dotNsId, "0"].reduce(
    (sec, j) => HDKD.secretSoft(sec, createChainCode(j)),
    walletSecret,
  );
  return {
    bareSecret,
    walletSecret,
    productSecret,
    productPublic: getPublicKey(productSecret),
    barePublic: getPublicKey(bareSecret),
    walletPublic: getPublicKey(walletSecret),
  };
}

/**
 * Well-known dev/test accounts that must never hold leaderboard points and are
 * blacklisted on every deployment. Used by the migration to scrub dev points
 * and re-seed the blacklist on a fresh contract. Lowercased H160s; compare
 * case-insensitively.
 *
 * Source of each address:
 *  - Substrate well-known DEV_PHRASE bare root, //Alice, //Bob — see
 *    `@polkadot-labs/hdkd-helpers` `DEV_PHRASE`. `bulletin-deploy` signs as
 *    all three (its DEFAULT_MNEMONIC equals DEV_PHRASE).
 *  - The first entry is a deploy-time signer used by this project's
 *    deployment tooling. It is included so contract awards routed to it are
 *    rejected by the blacklist as defense-in-depth, never to grant it any
 *    capability.
 */
export const DEV_ACCOUNTS: `0x${string}`[] = [
  "0x534507665bce7715a2894dec797e17e337a3d2e6", // project deploy signer
  "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20", // DEV_PHRASE bare root (used by bulletin-deploy)
  "0x9621dde636de098b43efb0fa9b61facfe328f99d", // //Alice
  "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01", // //Bob
];

/**
 * Asset-Hub websocket URL for diagnostic scripts. Pinned to the Paseo Next v2
 * endpoint that matches the `-n paseo` chain preset used by `cdm` and by the
 * product-sdk descriptor (`paseo_asset_hub`). Override via
 * `ASSET_HUB_WS_URL` for one-off runs against a custom endpoint.
 */
export function assetHubWsUrl(): string {
  return process.env.ASSET_HUB_WS_URL ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
}
