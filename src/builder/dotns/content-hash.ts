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

// IPFS content-hash encoding + setContenthash submission. Binds the
// registered `<label>.dot` node to the CID stored on Bulletin.

import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { PolkadotSigner } from "polkadot-api";
import { encode as encodeContentHash } from "@ensdomains/content-hash";
import { DOTNS_CONTRACTS } from "../config.ts";
import { CONTENT_RESOLVER_ABI } from "./abis.ts";
import { labelToFullName, namehash } from "./namehash.ts";
import {
    assertDryRunOk,
    dryRunContractCall,
    ensureAccountMapped,
    submitContractCall,
} from "./contracts.ts";

export function encodeIpfsContenthash(cidString: string): `0x${string}` {
    const encoded = encodeContentHash("ipfs", cidString);
    return `0x${encoded}` as `0x${string}`;
}

/**
 * Read the contenthash record for `label` from the FINALIZED block — the
 * state hosts and gateways resolve from. The deploy pipeline confirms at
 * best-block, so "tx succeeded" runs ~30-60s ahead of "site resolvable";
 * polling this until it returns the just-deployed CID's encoding closes
 * that gap honestly. Returns null when the record is absent or unreadable.
 */
export async function readContentHashFinalized(
    label: string,
    callerAddress: string,
): Promise<`0x${string}` | null> {
    const node = namehash(labelToFullName(label));
    const encoded = encodeFunctionData({
        abi: CONTENT_RESOLVER_ABI,
        functionName: "contenthash",
        args: [node],
    });
    const result = await dryRunContractCall(
        DOTNS_CONTRACTS.contentResolver,
        callerAddress,
        encoded,
        0n,
        "finalized",
    );
    if (!result.success || !result.returnData || result.returnData === "0x") return null;
    const decoded = decodeFunctionResult({
        abi: CONTENT_RESOLVER_ABI,
        functionName: "contenthash",
        data: result.returnData,
    }) as `0x${string}`;
    return decoded && decoded !== "0x" ? decoded : null;
}

export async function setContentHash(params: {
    label: string;
    cidString: string;
    signerAddress: string;
    signer: PolkadotSigner;
    onStatus?: (status: string) => void;
}): Promise<void> {
    const { label, cidString, signerAddress, signer, onStatus } = params;

    const node = namehash(labelToFullName(label));
    const contentBytes = encodeIpfsContenthash(cidString);

    await ensureAccountMapped(signerAddress, signer);

    const encoded = encodeFunctionData({
        abi: CONTENT_RESOLVER_ABI,
        functionName: "setContenthash",
        args: [node, contentBytes],
    });

    onStatus?.("Estimating gas for setContenthash…");
    const gasEstimate = await dryRunContractCall(
        DOTNS_CONTRACTS.contentResolver,
        signerAddress,
        encoded,
    );

    // A failed estimate previously fell back to default gas and submitted
    // anyway — paying fees for a guaranteed revert. Stop instead.
    assertDryRunOk(gasEstimate, "setContenthash");

    onStatus?.("Setting content hash…");
    await submitContractCall(
        DOTNS_CONTRACTS.contentResolver,
        signer,
        encoded,
        0n,
        gasEstimate.gasConsumed,
        gasEstimate.storageDeposit,
        (status) => {
            if (status === "signing") onStatus?.("Awaiting signature, content hash…");
            if (status === "broadcasting") onStatus?.("Broadcasting content hash…");
            if (status === "in-block") onStatus?.("Content hash set");
        },
    );
}
