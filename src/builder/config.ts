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

// Builder-local network config: DotNS contract addresses, gateway, and
// faucets for the active network. The rpc/genesis fields in
// networks.json are vestigial here — chain connections are owned by
// playground's SDK stack (product-sdk-chain-client / cloud-storage), which
// resolves endpoints from its own environment presets. This is a Summit-only
// fork: the "summit" SDK environment IS the chain these contract addresses
// live on (Summit Asset Hub genesis 0xf388dc6d…0660, Summit Bulletin genesis
// 0x147aae0d…ae77).
//
// Network selection follows the app-wide ENVIRONMENT (VITE_ENVIRONMENT) so the
// builder's gateway + DotNS contracts move in lockstep with the rest of the
// app rather than from a separate `active` field — a summit gateway paired with
// paseo contracts would be silently broken. networks.json is keyed by
// ENVIRONMENT, so the lookup is direct.

import { ENVIRONMENT } from "../config.ts";
import networksConfig from "./networks.json";

export interface BuilderNetworkConfig {
  name: string;
  description: string;
  ipfsGateway: string;
  dotHost: string;
  nativeToEthRatio: number;
  bulletinFaucetUrl: string;
  pasFaucetUrl: string;
  contracts: {
    registry: string;
    registrar: string;
    registrarController: string;
    contentResolver: string;
    popRules: string;
  };
}

const networks: Record<string, BuilderNetworkConfig> = networksConfig.networks;
export const NETWORK: BuilderNetworkConfig = networks[ENVIRONMENT];
if (!NETWORK) {
  throw new Error(
    `builder/networks.json: no network defined for ENVIRONMENT="${ENVIRONMENT}"`,
  );
}

export const BULLETIN_GATEWAY = `${NETWORK.ipfsGateway}/ipfs/`;

/** Host suffix where DotNS names resolve (e.g. `<name>.dot.li`). */
export const DOT_HOST = NETWORK.dotHost;

/** DotNS deployed contract addresses on the active network's Asset Hub. */
export const DOTNS_CONTRACTS = NETWORK.contracts;

/** Native-token base units → EVM Wei (18 decimals) conversion factor. */
export const NATIVE_TO_ETH_RATIO = BigInt(NETWORK.nativeToEthRatio);

/** Self-serve faucet for Bulletin storage authorization. */
export const BULLETIN_FAUCET_URL = NETWORK.bulletinFaucetUrl;

/** Faucet for native tokens to pay contract fees on Asset Hub. */
export const PAS_FAUCET_URL = NETWORK.pasFaucetUrl;
