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

import { getTruApi, isInsideContainerSync } from "@parity/product-sdk-host";
import type React from "react";
import { captureWarning } from "../lib/telemetry";
import { stringify } from "./stringify";

// Host detection + navigation route through `@parity/product-sdk-host` rather
// than the raw `@novasamatech/host-api-wrapper` transport, so all host access
// flows through one SDK surface (the same package used for accounts,
// allocations, permissions and preimages). `isInsideContainerSync()` replaces
// `sandboxTransport.isCorrectEnvironment()` — synchronous, so the in-host gate
// and `preventDefault()` run within the click gesture; `getTruApi()` replaces
// the `hostApi` singleton — async, and resolves `null` when the transport is
// unreachable.

/** Hand a URL to the host shell to navigate, falling back to a normal browser
 *  navigation if the host transport is unreachable or the navigation errors
 *  (the caller already `preventDefault()`ed, so either would be a dead click).
 *  Caller is expected to have gated on {@link isInsideContainerSync}. */
export async function navigateViaHost(url: string): Promise<void> {
  const truApi = await getTruApi();
  if (!truApi) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const result = await truApi.navigateTo({ tag: "v1", value: url });
  if (result.isErr()) {
    // stringify because the host's console wrapper flattens objects.
    captureWarning("host navigateTo failed", { url, error: stringify(result.error) });
    window.open(url, "_blank", "noopener");
  }
}

// Inside the Polkadot host (iframe/webview), route navigation through the host
// so the app shell handles the URL. Outside a host, fall through to the
// anchor's default browser navigation by NOT calling preventDefault.
export function handleExternalClick(e: React.MouseEvent<HTMLAnchorElement>) {
  // Outside the Polkadot host (normal browser), let the anchor navigate by
  // default — don't preventDefault, or the link does nothing.
  if (!isInsideContainerSync()) return;
  e.preventDefault();
  navigateViaHost(e.currentTarget.href);
}
