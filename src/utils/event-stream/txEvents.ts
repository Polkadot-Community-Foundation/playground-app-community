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

// Pure helpers for reading the registry's contract events back out of a
// submitted transaction's event list (papi `TxResult.events`). Kept chain-free
// (no contracts.ts import) so detection stays unit-testable without the
// module-load chain connect — callers supply the registry address.

import {
    decodeRegistryEventFromContractEmittedPayload,
    type ContractEmittedPayload,
} from "./registryEvents.ts";

// papi delivers each `TxResult` event as a SCALE-decoded system event:
// `{ phase, event: { type: <pallet>, value: { type: <event>, value: <fields> } }, topics }`.
// Dig the Revive.ContractEmitted `{ contract, data, topics }` fields out,
// unwrapping the phase shape (or accepting a bare pallet enum). Returns null
// for anything else.
export function contractEmittedFromTxEvent(ev: unknown): ContractEmittedPayload | null {
    const node = (ev as { event?: unknown })?.event ?? ev;
    const pallet = node as { type?: unknown; value?: { type?: unknown; value?: unknown } };
    if (pallet?.type !== "Revive" || pallet.value?.type !== "ContractEmitted") return null;
    const fields = pallet.value.value as { contract?: unknown; data?: unknown; topics?: unknown };
    if (!fields || fields.contract === undefined || fields.data === undefined) return null;
    return {
        contract: fields.contract,
        topics: Array.isArray(fields.topics) ? fields.topics : [],
        data: fields.data,
    };
}

// True iff the tx emitted a `FaucetFailed` for our registry — the contract emits
// it only when the contract-funded faucet was dry and the native-token transfer
// failed (the tx itself still reports `ok`). Reuses the same topic-keyed decoder
// the live event stream relies on. Best-effort: any decode miss (foreign event,
// papi shape drift) is skipped, so the caller treats it as "faucet was fine"
// rather than falsely warning the user.
export function faucetFailedFromEvents(
    events: readonly unknown[],
    registryAddress: string,
): boolean {
    for (const ev of events) {
        const payload = contractEmittedFromTxEvent(ev);
        if (!payload) continue;
        try {
            const decoded = decodeRegistryEventFromContractEmittedPayload(payload, registryAddress);
            if (decoded?.name === "FaucetFailed") return true;
        } catch {
            // Malformed / foreign event — treat as no failure and keep scanning.
        }
    }
    return false;
}
