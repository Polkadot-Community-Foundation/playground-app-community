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

// Pure detection of "did launch XP actually land" from a publish tx's events.
// Kept chain-free (no contracts.ts import) so it's unit-testable without the
// module-load chain connect — registry.ts supplies the registry address.

import { decodeRegistryEventFromContractEmittedPayload } from "../utils/event-stream/registryEvents.ts";
import { contractEmittedFromTxEvent } from "../utils/event-stream/txEvents.ts";

// `contractEmittedFromTxEvent` now lives in event-stream/txEvents.ts (its
// canonical home, shared with the faucet-failure detector). Re-exported here so
// existing importers and tests of this module are unaffected.
export { contractEmittedFromTxEvent };

// True iff the publish tx emitted a `DeployPointAwarded` for our registry —
// the contract emits it only when launch XP is actually credited. Reuses the
// same topic-keyed decoder the live event stream relies on. Best-effort: any
// decode miss (foreign event, papi shape drift) is skipped, so the caller
// under-claims rather than lying about XP the user didn't earn.
export function deployXpAwardedFromEvents(
    events: readonly unknown[],
    registryAddress: string,
): boolean {
    for (const ev of events) {
        const payload = contractEmittedFromTxEvent(ev);
        if (!payload) continue;
        try {
            const decoded = decodeRegistryEventFromContractEmittedPayload(payload, registryAddress);
            if (decoded?.name === "DeployPointAwarded") return true;
        } catch {
            // Malformed / foreign event — treat as no award and keep scanning.
        }
    }
    return false;
}
