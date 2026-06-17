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

// SS58 → H160 mapping via ReviveApi.address(). Returns the canonical on-chain
// H160 that pallet-revive uses as msg.sender for contract calls signed by
// this SS58 account.

import { getAssetHubClient } from "../chain.ts";
import { READ_DEADLINE_MS, withDeadline } from "../../utils/deadline.ts";

const cache = new Map<string, `0x${string}`>();

export async function getEvmAddress(ss58Address: string): Promise<`0x${string}`> {
    const cached = cache.get(ss58Address);
    if (cached) return cached;

    const { unsafeApi } = await getAssetHubClient();
    const result = await withDeadline(
        unsafeApi.apis.ReviveApi.address(ss58Address),
        READ_DEADLINE_MS,
        "Resolving the account's H160 on Asset Hub",
    );
    const hex = (result as { asHex?: () => string })?.asHex?.() ?? (result as string);

    if (typeof hex === "string" && hex.startsWith("0x") && hex.length === 42) {
        const evmAddr = hex.toLowerCase() as `0x${string}`;
        cache.set(ss58Address, evmAddr);
        return evmAddr;
    }

    throw new Error(`ReviveApi.address() returned unexpected result for ${ss58Address}: ${hex}`);
}
