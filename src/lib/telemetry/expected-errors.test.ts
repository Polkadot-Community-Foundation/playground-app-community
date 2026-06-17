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

import { describe, it, expect } from "vitest";
import { isPaymentError, isExpectedError } from "./expected-errors.ts";

describe("isExpectedError", () => {
  it("treats InsufficientFundsError as expected", () => {
    const e = new Error("x"); e.name = "InsufficientFundsError";
    expect(isExpectedError(e)).toBe(true);
  });
});

describe("isPaymentError", () => {
  it("matches the payment-class chain errors", () => {
    expect(isPaymentError(new Error("Invalid: Payment"))).toBe(true);
    expect(isPaymentError(new Error("InsufficientBalance"))).toBe(true);
    expect(isPaymentError(new Error("Out of gas"))).toBe(true);
    expect(isPaymentError("module error: InsufficientBalance")).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isPaymentError(new Error("AlreadyExists"))).toBe(false);
    expect(isPaymentError(new Error("NotOwner"))).toBe(false);
    expect(isPaymentError(undefined)).toBe(false);
    expect(isPaymentError(null)).toBe(false);
  });
});
