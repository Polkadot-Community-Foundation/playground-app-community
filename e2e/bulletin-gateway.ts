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

/**
 * Direct HTTP fetch against the Bulletin IPFS gateway.
 *
 * `@parity/product-sdk-cloud-storage`'s `CloudStorageClient.fetchJson` is container-only
 * (routes through the Polkadot host's preimage subscription) and would throw
 * `CloudStorageHostUnavailableError` from a plain-Node e2e harness. We hit the
 * gateway URL directly instead — same shape the legacy
 * `getGateway("paseo") + fetchJson` helpers produced.
 *
 * Defaults to the Summit IPFS gateway (production target); override via
 * `BULLETIN_GATEWAY_URL` for Paseo or a custom IPFS endpoint.
 */

const GATEWAY: string = (
  process.env.BULLETIN_GATEWAY_URL ?? "https://summit-ipfs.polkadot.io/ipfs"
).replace(/\/$/, "");

export async function gatewayFetchJson(cid: string): Promise<unknown> {
  const res = await fetch(`${GATEWAY}/${cid}`);
  if (!res.ok) throw new Error(`Gateway fetch ${cid} → ${res.status}`);
  return res.json();
}
