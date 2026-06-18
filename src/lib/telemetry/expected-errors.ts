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

import { isSigningRejection } from "@parity/product-sdk-tx";

// Predicates that classify journey failures. `journey.expected = "true"`
// keeps user-input errors out of Sentry's failure_rate(); a custom
// `journey.status:error` query still shows total failures.
//
// Add patterns when you see a recurring user-side error inflate the
// unexpected-failure dashboard.

const EXPECTED_PATTERNS: RegExp[] = [
  /AccountUnmapped/i,                                  // not yet mapped via Revive.map_account()
  /InsufficientBalance|Out of gas|Invalid: Payment/i,  // funder dry / fee shortfall
  /AlreadyExists|already exists|already taken/i,       // domain conflict
  /NotOwner|Unauthori[sz]ed|Forbidden/i,               // signer doesn't own the domain
  /ContractReverted/i,                                 // contract-level invariant
];

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return err == null ? "" : String(err);
}

export function isExpectedError(err: unknown): boolean {
  if (isSigningRejection(err)) return true;
  if (err instanceof Error && err.name === "InsufficientFundsError") return true;
  // The guard's identity gate — a not-yet-builder routed to onboarding, not a
  // failure (see utils/guardedWrite.ts).
  if (err instanceof Error && err.name === "NotABuilderError") return true;
  const msg = errMsg(err);
  return msg !== "" && EXPECTED_PATTERNS.some((re) => re.test(msg));
}

// The fee/funds subset of EXPECTED_PATTERNS — used to route a write failure
// into the resource drip (see utils/guardedWrite.ts). Kept in sync with the
// "funder dry / fee shortfall" entry above.
const PAYMENT_PATTERN = /InsufficientBalance|Out of gas|Invalid: Payment/i;

export function isPaymentError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg !== "" && PAYMENT_PATTERN.test(msg);
}

export { isSigningRejection };
