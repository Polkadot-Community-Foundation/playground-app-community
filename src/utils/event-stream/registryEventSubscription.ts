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

import * as Sentry from "@sentry/react";
import { contractsReady } from "../contracts.ts";
import {
  contractEmittedPayloadsFromWatchValue,
  decodeRegistryEventFromContractEmittedPayload,
  type DecodedRegistryEvent,
} from "./registryEvents";

export type RegistryEventCallback = (event: DecodedRegistryEvent) => void;

// WS halts can fire decode errors many times per second; cap at one Sentry event
// per minute per source so a flaky asset hub doesn't drown the project quota.
const WS_ERROR_REPORT_INTERVAL_MS = 60_000;
const lastWsErrorReportAt: Record<string, number> = {};

function reportWsError(err: unknown, source: string): void {
  const now = Date.now();
  if (now - (lastWsErrorReportAt[source] ?? 0) < WS_ERROR_REPORT_INTERVAL_MS) return;
  lastWsErrorReportAt[source] = now;
  Sentry.captureException(err, { tags: { phase: "chain-ws", source } });
}

export function subscribeToRegistryEvents(callback: RegistryEventCallback): () => void {
  let cancelled = false;
  let unsubscribe: (() => void) | null = null;

  contractsReady.then(({ client, registryAddress }) => {
    // Caller may have unmounted before contractsReady resolved; bail out.
    if (cancelled) return;

    const sub = client.assetHub.event.Revive.ContractEmitted.watchBest().subscribe({
      next(value: unknown) {
        for (const payload of contractEmittedPayloadsFromWatchValue(value)) {
          try {
            const decoded = decodeRegistryEventFromContractEmittedPayload(payload, registryAddress);
            if (!decoded) continue;

            callback(decoded);
          } catch (err) {
            // polkadot-api throws "Cannot read properties of undefined (reading 'children')"
            // when a chainHead follow drops mid-decode (after WS halt).
            reportWsError(err, "event-decode");
          }
        }
      },
      error(err: unknown) {
        reportWsError(err, "subscription-error");
      },
    });
    unsubscribe = () => sub.unsubscribe();
  }).catch((err) => {
    reportWsError(err, "subscription-start");
  });

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}
