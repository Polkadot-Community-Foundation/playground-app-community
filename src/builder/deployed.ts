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

// Local record of this device's successful deploys, for the landing page's
// "Your sites" chip list. Deliberately localStorage-only (same trust model
// as drafts): the chain knows ownership, but querying DotNS for "all names
// owned by this account" is an enumeration the contracts don't offer — and
// a local list is exactly the "sites I made here" the landing page wants.

export interface DeployedSite {
  /** Bare label, no `.dot` suffix. */
  domain: string;
  /** Gateway URL as returned by the deploy (PopupLink converts in-host). */
  url: string;
  deployedAt: number;
}

const KEY = "site-builder.deployed.v1";

export function loadDeployedSites(): DeployedSite[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is DeployedSite =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as DeployedSite).domain === "string" &&
        typeof (s as DeployedSite).url === "string",
    );
  } catch {
    return [];
  }
}

/** Newest first; a re-deploy of the same domain moves it to the front. */
export function recordDeployedSite(domain: string, url: string): void {
  try {
    const rest = loadDeployedSites().filter((s) => s.domain !== domain);
    localStorage.setItem(
      KEY,
      JSON.stringify([{ domain, url, deployedAt: Date.now() }, ...rest]),
    );
  } catch {
    // Quota / private browsing — the list is a convenience, not state.
  }
}
