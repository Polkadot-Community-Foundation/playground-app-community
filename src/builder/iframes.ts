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

// Some hosts forbid iframes outright — Polkadot Mobile's Android webview
// throws "iframe creation is not allowed", which crashed the landing page
// the moment React rendered the first thumbnail. Probe the capability once
// (creation AND attach, since hosts may hook either) so the thumbnails and
// the preview frame can degrade instead of dying in the error boundary.

import { captureWarning } from "../lib/telemetry";

// Success is cached forever; failure is RETRIED (at most every few seconds).
// hello-playground's identical preview iframe works on the same Android
// device that blocked ours — and the only structural difference is that our
// landing creates iframes at boot, so the guard is likely phase-sensitive.
// A permanent false verdict from one early throw would downgrade the whole
// session needlessly.
let allowed = false;
let lastFailureAt = 0;
let reported = false;
const RETRY_MS = 5_000;

export function iframesAllowed(): boolean {
    if (allowed) return true;
    const now = Date.now();
    if (lastFailureAt && now - lastFailureAt < RETRY_MS) return false;
    try {
        const el = document.createElement("iframe");
        el.style.display = "none";
        document.body.appendChild(el);
        el.remove();
        allowed = true;
    } catch (cause) {
        lastFailureAt = now;
        // The guard is HOST-injected (the string isn't in our bundle), so
        // the captured stack is the only window into which host policy
        // tripped. Report once per session — not per retry.
        if (!reported) {
            reported = true;
            captureWarning("iframe capability probe failed", {
                error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
                stack: cause instanceof Error ? cause.stack : undefined,
            });
        }
    }
    return allowed;
}
