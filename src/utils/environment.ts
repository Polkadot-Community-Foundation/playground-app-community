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

import { MOBILE_QUERY } from "./hooks";

declare global {
  interface Window {
    /**
     * Polkadot Mobile (Android) injects this JS-interface bridge via
     * `addJavascriptInterface`; absent in every other environment.
     */
    Android?: { call?: (fn: string, argsJson: string) => string };
    /**
     * WKWebView message-handler bridge. Present in the Polkadot Mobile (iOS)
     * host — which registers a `__container__` handler — and in Safari/WKWeb
     * generally (where `__container__` is absent).
     */
    webkit?: { messageHandlers?: Record<string, unknown> };
  }
}

/**
 * Where the user is working — used to pick the default InstructionTabs panel.
 * "desktop" is the local CLI flow, "web" the in-browser flow (Site Builder /
 * RevX), "mobile" a phone.
 */
export type Environment = "desktop" | "web" | "mobile";

/**
 * One-shot detection of the working environment, used only to choose the
 * initial tab — the tabs stay manually switchable, so this never needs to be
 * reactive.
 *
 * The hosts don't advertise a platform field (the host-api handshake only
 * negotiates a protocol version), so detection reads the signals each host
 * actually injects, in this order:
 *
 *  1. A mobile-sized viewport is always "mobile" — a mobile browser is mobile,
 *     not web, and this keeps the default tab in lockstep with the journey's
 *     mobile reorder (same breakpoint), so they can never disagree. This wins
 *     even inside a host: a Desktop window narrowed past the breakpoint reads
 *     as mobile, matching the reordered layout.
 *  2. A wide viewport can still be a native mobile host (e.g. a tablet):
 *     Polkadot Mobile (iOS) registers a `webkit.messageHandlers.__container__`
 *     handler and Polkadot Mobile (Android) injects `window.Android.call` —
 *     each unique to that host.
 *  3. Polkadot Desktop (Electron webview) sets `__HOST_WEBVIEW_MARK__` but has
 *     neither mobile bridge => "desktop".
 *  4. Otherwise it's a wide browser — the dot.li gateway (a cross-origin iframe
 *     that injects nothing) or a plain browser => "web".
 */
export function detectEnvironment(): Environment {
  if (typeof window === "undefined") return "web";
  if (isMobileViewport()) return "mobile";
  if (isIosHost() || isAndroidHost()) return "mobile";
  if (window.__HOST_WEBVIEW_MARK__ === true) return "desktop";
  return "web";
}

/** iOS WKWebView host: registers a `__container__` handler (plain Safari doesn't). */
function isIosHost(): boolean {
  return window.webkit?.messageHandlers?.__container__ !== undefined;
}

/** Android WebView host: injects a `window.Android` interface with `.call`. */
function isAndroidHost(): boolean {
  return typeof window.Android?.call === "function";
}

function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}
