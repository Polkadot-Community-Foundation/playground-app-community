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
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { summit_asset_hub } from "@parity/product-sdk-descriptors/summit-asset-hub";
import { ENVIRONMENTS, type Environment } from "../src/config.ts";

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

// Asset-Hub websocket endpoints per chain — kept in sync with
// `src/builder/networks.json` (the `assetHubRpc` field of each network).
// Hard-coded rather than read from networks.json because the scripts need a
// raw WS url (the SDK chain-client is host-only and has no Node fallback),
// while networks.json's rpc fields are documented as vestigial for the app.
const ASSET_HUB_WS: Record<Environment, string> = {
  paseo: "wss://paseo-asset-hub-next-rpc.polkadot.io",
  summit: "wss://summit-asset-hub-rpc.polkadot.io",
};

/**
 * Resolve the target chain for a script run from the `CHAIN` env var, defaulting
 * to `"paseo"` — unchanged from when these scripts were paseo-only, so existing
 * invocations keep working. An explicitly-set unknown value throws rather than
 * silently targeting the wrong network. Reuses the frontend's `ENVIRONMENTS` so
 * the selectable-network set has a single source of truth (only chains with a
 * full product-sdk descriptor set qualify — CDM-only `w3s`/`local` do not).
 */
export function resolveChain(): Environment {
  const raw = process.env.CHAIN?.trim().toLowerCase();
  if (!raw) return "paseo";
  if ((ENVIRONMENTS as readonly string[]).includes(raw)) return raw as Environment;
  throw new Error(
    `CHAIN="${raw}" is not a supported network. Use one of: ${ENVIRONMENTS.join(", ")}.`,
  );
}

/** PAPI Asset-Hub descriptor for the given chain, matching the frontend's
 *  ENVIRONMENT-keyed selection in `src/utils/contracts.ts`. */
export function assetHubDescriptor(chain: Environment) {
  return chain === "summit" ? summit_asset_hub : paseo_asset_hub;
}

/**
 * Asset-Hub websocket URL for diagnostic scripts, keyed on the target chain
 * (default `"paseo"`). Matches the `-n <chain>` preset used by `cdm` and the
 * product-sdk descriptor. Override via `ASSET_HUB_WS_URL` for one-off runs
 * against a custom endpoint (applies regardless of chain).
 */
export function assetHubWsUrl(chain: Environment = "paseo"): string {
  return process.env.ASSET_HUB_WS_URL ?? ASSET_HUB_WS[chain];
}
