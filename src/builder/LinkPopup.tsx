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

// In-host link handling. Browsers navigate normally; hosts navigate via
// navigateViaHost (utils/externalNavigation, which routes through the host's
// navigateTo) with the full `https://name.dot.li` URL — the same form the
// proven LaunchButton path passes. The Android
// host can't resolve the bare `name.dot` form ("site not found"), so we hand
// it the full gateway URL instead. The Android host used to drop the
// navigateTo outcome silently (polkadot-app-android-v2#858 / #864) and got a
// UA-gated copy-link popup instead of a dead click — that special case was
// removed when the fixed host release shipped (#864, merged 2026-06-12). Hosts
// still expose no version signal (#861), so a not-yet-updated Android host
// degrades to a silent no-op click here.

import { type AnchorHTMLAttributes } from "react";
import { isInsideContainerSync } from "@parity/product-sdk-host";
import { navigateViaHost } from "../utils/externalNavigation";

/** The form of a link worth opening or COPYING in the current environment.
 *  Inside a host, the user's browser IS the host — it resolves `.dot`
 *  natively, so hand it the raw `.dot` form instead of a `.dot.li` gateway
 *  detour. Outside a host (or for non-dot links), the URL passes through
 *  unchanged. */
export function hostLinkForm(url: string): string {
    if (!isInsideContainerSync()) return url;
    try {
        const u = new URL(url);
        if (u.hostname.endsWith(".dot.li") || u.hostname.endsWith(".dot")) {
            // BARE form, no scheme: the host's browser bar expects
            // `name.dot`, not an https:// URL.
            const host = u.hostname.replace(/\.dot\.li$/, ".dot");
            const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
            return host + rest;
        }
    } catch {
        // not a parseable URL — copy as-is
    }
    return url;
}

/** Drop-in replacement for external `<a target="_blank">` links. */
export function PopupLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
    const { href, onClick, children, ...rest } = props;
    return (
        <a
            {...rest}
            href={href}
            target="_blank"
            rel="noopener"
            onClick={(e) => {
                onClick?.(e);
                if (!href || !isInsideContainerSync()) return;
                // In-host: hand the host the anchor's FULL href (the `.dot.li`
                // gateway URL — see top-of-file comment for why bare `.dot`
                // fails on Android). navigateViaHost owns the dead-click
                // fallback. (hostLinkForm is the shape for COPYING a link.)
                e.preventDefault();
                navigateViaHost(href);
            }}
        >
            {children}
        </a>
    );
}
