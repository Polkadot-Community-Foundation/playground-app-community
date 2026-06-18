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

import type { SignerAccount } from "@parity/product-sdk-signer";
import { captureWarning } from "../lib/telemetry";
import { stringify } from "./stringify.ts";
import { contractsReady } from "./contracts.ts";
import {
  PGAS_ASSET_ID,
  PGAS_QUERY_TIMEOUT_MS,
  MIN_NATIVE_PLANCK,
  MIN_PGAS,
} from "./fundsFloors.ts";

// Floor constants live in the dependency-free leaf `fundsFloors.ts` so pure
// consumers can read them without importing the chain client. Re-exported here
// for the existing import sites (contracts.ts re-export chain, etc.).
export { PGAS_ASSET_ID, PGAS_QUERY_TIMEOUT_MS, MIN_NATIVE_PLANCK, MIN_PGAS };

/**
 * Timeout-bounded balance reader. Returns `null` on any error or timeout so
 * callers can distinguish "we don't know" from "definitely zero".
 */
export async function boundedRead(
  fn: () => Promise<bigint>,
  label: string,
): Promise<bigint | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${PGAS_QUERY_TIMEOUT_MS / 1000}s`)),
          PGAS_QUERY_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (cause) {
    console.warn(`[playground] ${label} failed: ${stringify(cause)}`);
    captureWarning(`${label} failed`, { error: stringify(cause) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the PGAS (sufficient asset) balance for an account, or `null` if
 * the read times out or fails.
 */
export async function getPgasBalance(account: SignerAccount): Promise<bigint | null> {
  return boundedRead(async () => {
    const { client } = await contractsReady;
    const acct = await client.assetHub.query.Assets.Account.getValue(
      PGAS_ASSET_ID,
      account.address,
    );
    return acct?.balance ?? 0n;
  }, "PGAS balance query");
}

/**
 * Returns the native PAS (planck) free balance for an account, or `null` if
 * the read times out or fails.
 */
export async function getNativeBalance(account: SignerAccount): Promise<bigint | null> {
  return boundedRead(async () => {
    const { client } = await contractsReady;
    const acct = await client.assetHub.query.System.Account.getValue(account.address);
    return acct?.data?.free ?? 0n;
  }, "native balance query");
}

/**
 * Returns `true` if the account has enough funds to attempt a contract write —
 * either at least {@link MIN_NATIVE_PLANCK} native PAS OR at least
 * {@link MIN_PGAS} PGAS. Both reads run in parallel; a `null` result (timeout
 * or error) is treated conservatively as zero. If BOTH reads fail we return
 * `false` (reject the write) rather than silently burning a doomed transaction.
 */
export async function hasSufficientFunds(account: SignerAccount): Promise<boolean> {
  const [native, pgas] = await Promise.all([getNativeBalance(account), getPgasBalance(account)]);
  return (native ?? 0n) >= MIN_NATIVE_PLANCK || (pgas ?? 0n) >= MIN_PGAS;
}

/**
 * Thrown when a pre-flight funds check determines the account has neither
 * enough native PAS nor enough PGAS to proceed with a contract write.
 * Callers should route the user to the resource drip or display a
 * friendly "insufficient funds" message.
 */
export class InsufficientFundsError extends Error {
  constructor(message = "Not enough resources to complete this action.") {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

export function isInsufficientFundsError(err: unknown): boolean {
  return err instanceof Error && err.name === "InsufficientFundsError";
}
