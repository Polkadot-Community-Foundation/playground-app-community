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

// Asset Hub client for the builder's DotNS layer, backed by playground's
// chain stack (product-sdk-chain-client → host provider). The dotns bridge
// keeps its ReviveApi dry-runs on the UNSAFE api on purpose: unsafe calls
// bypass descriptor-compatibility checks, so descriptor drift against the
// live runtime can't brick the read path (the property that has saved this
// code before). Only `api.tx.Revive.*` is typed.

import { resolveActiveChainClient, type ActiveChainClient } from "./activeChainClient.ts";
import { withDeadline, READ_DEADLINE_MS } from "../utils/deadline.ts";

type ChainClient = ActiveChainClient;

export interface AssetHubHandle {
  api: ChainClient["assetHub"];
  unsafeApi: ReturnType<ChainClient["raw"]["assetHub"]["getUnsafeApi"]>;
}

let cached: Promise<AssetHubHandle> | null = null;

// Memoize the handle, but make the cache SELF-HEALING. `cached ??= …` stores a
// promise, not a result: without the `.catch` below, a connect that rejects (or
// times out) under congestion would be cached as a permanently-rejected promise
// — every later caller re-awaits the same failure and the only escape is an app
// restart. The `.catch` nulls the slot so the next call genuinely reconnects,
// and `withDeadline` converts a HANGING connect (the host transport's typical
// failure mode) into that same rejection instead of a forever-pending promise.
// Mirrors the `pendingSignerReady` reset pattern in utils/contracts.ts.
export function getAssetHubClient(): Promise<AssetHubHandle> {
  return (cached ??= withDeadline(
    resolveActiveChainClient(),
    READ_DEADLINE_MS,
    "Asset Hub connection",
  )
    .then((client) => ({
      api: client.assetHub,
      unsafeApi: client.raw.assetHub.getUnsafeApi(),
    }))
    .catch((cause) => {
      cached = null;
      throw cause;
    }));
}

// Drop the memoized handle so the NEXT getAssetHubClient() rebuilds it. The
// socket behind a long-lived handle can wedge — e.g. after the WebView is
// backgrounded — leaving queries pending forever; the only recovery short of a
// page reload is to stop reusing it. Called from the deploy panel's
// foreground-recovery path so a re-run reconnects instead of re-hanging.
export function resetAssetHubClient(): void {
  cached = null;
}
