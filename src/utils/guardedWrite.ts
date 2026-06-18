// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) Parity Technologies (UK) Ltd.

import { hasSufficientFunds, InsufficientFundsError, signerManager } from "./contracts.ts";
import { isRevealedNow } from "./identity.ts";
import { requestResources } from "./resources.ts";
import { triggerBecomeBuilder } from "./dripBridge.ts";
import { isPaymentError } from "../lib/telemetry";

/**
 * Thrown when a not-yet-builder tries to write on-chain. The guard routes them
 * to the Become-a-builder flow and aborts; callers treat this as a soft
 * cancellation (no Sentry capture), exactly like {@link InsufficientFundsError}.
 */
export class NotABuilderError extends Error {
  constructor(message = "Become a builder to do this.") {
    super(message);
    this.name = "NotABuilderError";
  }
}

export function isNotABuilderError(err: unknown): boolean {
  return err instanceof Error && err.name === "NotABuilderError";
}

// Wrap a contract-write thunk with identity + funds protection:
//  - Identity is the gate: a not-yet-builder is routed to the Become-a-builder
//    flow (one bundled approval) and the write aborts.
//  - A builder who's just out of allowance gets an explicit faucet top-up
//    FIRST, then the original write proceeds — no re-tap ("first faucet, then
//    run that command").
//  - Reactive: if the write throws a payment-class error anyway (race / read
//    timeout that proceeded optimistically), open the flow before rethrowing.
// When not connected, skip the pre-checks — ensureSignerReady (inside the
// write) owns the connect/allowance path.
export async function guardedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const account = signerManager.getState().selectedAccount;
  if (account) {
    const h160 = account.h160Address;
    if (h160 && !(await isRevealedNow(h160))) {
      triggerBecomeBuilder();
      throw new NotABuilderError();
    }
    if (!(await hasSufficientFunds(account))) {
      // Already a builder, just out of allowance — faucet explicitly, then let
      // the write run. A declined host prompt becomes a soft shortfall.
      try {
        await requestResources();
      } catch {
        throw new InsufficientFundsError();
      }
    }
  }
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InsufficientFundsError || isPaymentError(err)) {
      triggerBecomeBuilder();
    }
    throw err;
  }
}
