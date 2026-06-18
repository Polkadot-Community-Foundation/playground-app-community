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
import type { PolkadotSigner } from "polkadot-api";
import { SpanOp, isSigningRejection } from "../lib/telemetry";
import { ensureSignerReady, signerManager } from "./contracts.ts";
import { stringify } from "./stringify.ts";

/**
 * Run a contract `.tx()` call with diagnostic logging on failure. Substrate's
 * `Revive.ContractReverted` dispatch error doesn't carry the revert payload,
 * so failures show up as a generic dispatch error in the log; the actual
 * revert reason needs to be inferred from the contract code or by tracing
 * on a chain that supports `ReviveApi.trace_call`.
 *
 * Internally awaits `ensureSignerReady()` (connect + allowance) and passes
 * the resolved signer as a ready-to-spread `{ signer }` options object, so
 * call sites read `(opts) => registry.foo.tx(...args, opts)`. This is how
 * all writes flip from anonymous Alice reads to the connected user.
 */
/**
 * Pass-through tx options. `waitFor: "best-block"` is recommended for quick
 * interactive writes (star, set_username) where the UI should refresh
 * the moment the tx is in a best block, even if it's not finalized yet. The
 * sequential publish pipeline still wants finalized so each step sees the
 * previous one's effect — leave the default alone there.
 *
 * `gasLimit` / `storageDepositLimit` override the SDK's auto-estimator. The
 * estimator dry-runs at the prior-tx state, and for writes that create new
 * storage slots (e.g. set_username inserting BOTH `usernames` and
 * `username_to_owner`) the estimate has been observed to undershoot and the
 * tx lands as `Revive.OutOfGas`. Pin the limits high to bypass the
 * estimator entirely. Use the same numbers as `scripts/smoke-test-*.ts`.
 */
type TxPassThrough = {
  waitFor?: "best-block" | "finalized";
  gasLimit?: { ref_time: bigint; proof_size: bigint };
  storageDepositLimit?: bigint;
  /**
   * SS58 origin for the pre-submit dry-run. Defaults to the connected
   * account (resolved below) — only set this to override. Omitting it is the
   * common case; see the auto-injection note in `runTx`.
   */
  origin?: string;
};

export async function runTx<T>(
  label: string,
  txFn: (opts: { signer: PolkadotSigner } & TxPassThrough) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
  txOpts?: TxPassThrough,
): Promise<T> {
  return Sentry.startSpan(
    {
      name: `registry.${label}`,
      op: SpanOp.CHAIN_TX,
      // `tx.cancelled` defaults to "false" so the % cancelled widget query
      // has a denominator on every span — the rejection branch flips it.
      attributes: { label, "tx.cancelled": "false", ...attributes },
    },
    async (span: Sentry.Span) => {
      try {
        const signer = await ensureSignerReady();
        // Pin the dry-run origin to the connected account. Resolved AFTER
        // ensureSignerReady so a just-completed connect has populated
        // selectedAccount. Without an explicit origin the SDK estimates gas as
        // `defaultOrigin` (the read-only pallet-revive query account), so
        // any caller()-gated method reverts during the un-submitted dry-run
        // (Unauthorized / etc.). Callers may override via txOpts.
        const origin = txOpts?.origin ?? signerManager.getState().selectedAccount?.address;
        const result = await txFn({ signer, ...txOpts, origin });
        if ((result as { ok?: unknown })?.ok === false) {
          span.setStatus({ code: 2, message: "tx-not-ok" });
          console.error(`[tx ${label}] result.ok=false\n${stringify(result)}`);
        }
        return result;
      } catch (err) {
        // `tx.cancelled` separates user cancellations from real failures
        // in the spans dataset — the throw still escapes, but Sentry's
        // auto-fail status is otherwise indistinguishable.
        if (isSigningRejection(err)) {
          span.setAttribute("tx.cancelled", "true");
          console.debug(`[tx ${label}] user rejected`);
        } else {
          console.error(`[tx ${label}] threw\n${stringify(err)}`);
        }
        throw err;
      }
    },
  );
}
