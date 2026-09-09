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

import { navigateTo, isInsideContainerSync } from "@parity/product-sdk-host";
import type React from "react";
import { captureWarning } from "../lib/telemetry";
import { stringify } from "./stringify";

// Host detection + navigation route through `@parity/product-sdk-host` (whose
// transport is `@parity/truapi`), so all host access flows through one SDK
// surface (the same package used for accounts, allocations, permissions and
// preimages). `isInsideContainerSync()` is the synchronous in-host gate, so it
// and `preventDefault()` run within the click gesture; navigation uses the
// first-class `navigateTo(url)` helper, which returns the host's Result union
// and errors (rather than throwing) when the host is unreachable.

/** Hand a URL to the host shell to navigate, falling back to a normal browser
 *  navigation if the host transport is unreachable or the navigation errors
 *  (the caller already `preventDefault()`ed, so either would be a dead click).
 *  Caller is expected to have gated on {@link isInsideContainerSync}. */
export async function navigateViaHost(url: string): Promise<void> {
  // `navigateTo` is now a first-class helper (the raw `truApi.navigateTo` +
  // `{tag:"v1",value}` envelope are gone) - it wraps `truApi.system.navigateTo`
  // and returns the host's Result union, erroring (not throwing) when the host
  // is unreachable, so a single !ok branch covers both no-host and nav failure.
  const result = await navigateTo(url);
  if (!result.ok) {
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
