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

// Generic Observable→Promise bridge for createSubmitAndWatch. Reused by both
// the Bulletin store path and the pallet-revive contract calls.

import type { Transaction, TxCreator } from "polkadot-api";

export type DeployStatus = "signing" | "broadcasting" | "in-block" | "finalized";

interface SubmitResult {
    blockHash: string;
    blockNumber: number;
}

export async function submitAndWait(
    tx: Transaction,
    signer: TxCreator,
    onStatus?: (status: DeployStatus) => void,
    // The dispatch outcome (ok/dispatchError) is already known at
    // inBestBlock, so "inBlock" is the default — waiting for finality
    // added ~15-30s per transaction for no extra information. Every failure
    // mode past in-block (reorg drops the tx) is retryable and surfaced;
    // pass "finalized" for calls where a reorg would be unrecoverable.
    waitFor: "inBlock" | "finalized" = "inBlock",
): Promise<SubmitResult> {
    return new Promise((resolve, reject) => {
        let sub: { unsubscribe: () => void } | undefined;

        onStatus?.("signing");

        sub = tx.createSubmitAndWatch(signer).subscribe({
            next: (ev) => {
                if (ev.type === "broadcasted") onStatus?.("broadcasting");

                if (ev.type === "inBestBlock") {
                    if (!ev.ok) {
                        sub?.unsubscribe();
                        const info = JSON.stringify(ev.dispatchError, (_, v) =>
                            typeof v === "bigint" ? String(v) : v,
                        );
                        reject(new Error(`Transaction failed: ${info}`));
                        return;
                    }
                    onStatus?.("in-block");
                    if (waitFor === "inBlock") {
                        sub?.unsubscribe();
                        resolve({ blockHash: ev.block.hash, blockNumber: ev.block.number });
                    }
                }

                if (ev.type === "finalized") {
                    sub?.unsubscribe();
                    if (!ev.ok) {
                        const info = JSON.stringify(ev.dispatchError, (_, v) =>
                            typeof v === "bigint" ? String(v) : v,
                        );
                        reject(new Error(`Transaction failed: ${info}`));
                        return;
                    }
                    onStatus?.("finalized");
                    resolve({ blockHash: ev.block.hash, blockNumber: ev.block.number });
                }
            },
            error: (err: unknown) => {
                sub?.unsubscribe();
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        });
    });
}
