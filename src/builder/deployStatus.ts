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

// Maps a human-facing deploy/upload status line to its progress-bar step
// index. The status strings are matched by PREFIX, so the granular per-phase
// wording emitted by the chain helpers (dotns/register.ts, dotns/content-
// hash.ts, store.ts) must stay in sync with the prefixes here — that coupling
// is exactly what deployStatus.test.ts guards. Lifted out of BuilderApp.tsx
// (pure logic, no React) so it can be tested in isolation.
//
// IMPORTANT: the per-tx status helpers report "Awaiting signature — …" (NOT
// "Waiting …") for the signing phase precisely so it doesn't collide with the
// commitment-age "DotNS register: Waiting Ns…" line, which routes to the Wait
// step. Keep that distinction if you reword either side.

// Upload pipeline (image stores): mirrors UPLOAD_STEPS in BuilderApp.tsx.
export function stepForUploadStatus(message: string): number {
    if (message.startsWith("signing")) return 1;
    if (message.startsWith("broadcasting")) return 2;
    if (message.startsWith("in-block")) return 3;
    if (message.startsWith("finalized")) return 4;
    return 0;
}

// Deploy pipeline: mirrors DEPLOY_STEPS in BuilderApp.tsx
// (prepare, bulletin, account, name, commit, wait, register, link).
export function stepForDeployStatus(message: string): number {
    if (message.startsWith("Bulletin:")) return 1;
    if (message.startsWith("DotNS: resolving owner")) return 2;
    if (message.startsWith("DotNS: checking domain")) return 3;
    // Owned-name update path skips commit/wait/register entirely.
    if (message.startsWith("DotNS: domain name already yours")) return 6;
    if (message.startsWith("DotNS register: Waiting")) return 5;
    if (
        message.startsWith("DotNS register: Pricing") ||
        message.startsWith("DotNS register: Awaiting signature, registering") ||
        message.startsWith("DotNS register: Registering") ||
        message.startsWith("DotNS register: Domain name registered")
    ) {
        return 6;
    }
    if (message.startsWith("DotNS register:")) return 4;
    if (message.startsWith("DotNS resolver:")) return 7;
    if (message.startsWith("DotNS step failed")) return 7;
    return 0;
}
