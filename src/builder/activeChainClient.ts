// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Resolves the active chain client via the SDK's named-environment preset
// (getChainAPI). All of `paseo` / `summit` / `devnet` are first-class SDK
// environments (@parity chain-client `Environment` = polkadot|kusama|paseo|
// summit|devnet), so CHAIN maps straight onto a preset — no BYOD descriptors.
// Connections route through the host provider; the preset descriptors only
// type/decode the chains.
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { CHAIN } from "../config.ts";

export type ActiveChainClient = Awaited<ReturnType<typeof getChainAPI>>;

export function resolveActiveChainClient(): Promise<ActiveChainClient> {
  return getChainAPI(CHAIN);
}
