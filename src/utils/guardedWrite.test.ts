// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) Parity Technologies (UK) Ltd.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hasSufficientFunds = vi.fn();
const selectedAccount = { current: { address: "x", h160Address: "0xabc" } as any };
vi.mock("./contracts.ts", () => ({
  hasSufficientFunds: (...a: unknown[]) => hasSufficientFunds(...a),
  InsufficientFundsError: class extends Error { name = "InsufficientFundsError"; },
  signerManager: { getState: () => ({ selectedAccount: selectedAccount.current }) },
}));
const isRevealedNow = vi.fn();
vi.mock("./identity.ts", () => ({ isRevealedNow: (...a: unknown[]) => isRevealedNow(...a) }));
const requestResources = vi.fn();
vi.mock("./resources.ts", () => ({ requestResources: () => requestResources() }));
const triggerBecomeBuilder = vi.fn();
vi.mock("./dripBridge.ts", () => ({ triggerBecomeBuilder: () => triggerBecomeBuilder() }));
const isPaymentError = vi.fn();
vi.mock("../lib/telemetry", () => ({ isPaymentError: (e: unknown) => isPaymentError(e) }));

import { guardedWrite } from "./guardedWrite.ts";

describe("guardedWrite", () => {
  beforeEach(() => {
    hasSufficientFunds.mockReset();
    isRevealedNow.mockReset();
    requestResources.mockReset();
    triggerBecomeBuilder.mockReset();
    isPaymentError.mockReset();
    selectedAccount.current = { address: "x", h160Address: "0xabc" };
    // Default: a revealed builder with funds — the common happy path.
    isRevealedNow.mockResolvedValue(true);
    hasSufficientFunds.mockResolvedValue(true);
    requestResources.mockResolvedValue(undefined);
  });

  it("runs the write for a revealed, funded builder", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(guardedWrite(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalled();
    expect(triggerBecomeBuilder).not.toHaveBeenCalled();
    expect(requestResources).not.toHaveBeenCalled();
  });

  it("routes a not-yet-builder to Become-a-builder and does NOT run the write", async () => {
    isRevealedNow.mockResolvedValue(false);
    const fn = vi.fn();
    await expect(guardedWrite(fn)).rejects.toMatchObject({ name: "NotABuilderError" });
    expect(fn).not.toHaveBeenCalled();
    expect(triggerBecomeBuilder).toHaveBeenCalledTimes(1);
    // Gate on identity first — don't even read funds for a non-builder.
    expect(hasSufficientFunds).not.toHaveBeenCalled();
  });

  it("faucets first, then runs the write, for a revealed builder out of allowance", async () => {
    hasSufficientFunds.mockResolvedValue(false);
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(guardedWrite(fn)).resolves.toBe("ok");
    expect(requestResources).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalled();
  });

  it("throws InsufficientFundsError (and skips the write) when the top-up faucet is declined", async () => {
    hasSufficientFunds.mockResolvedValue(false);
    requestResources.mockRejectedValue(new Error("PermissionDenied"));
    const fn = vi.fn();
    await expect(guardedWrite(fn)).rejects.toMatchObject({ name: "InsufficientFundsError" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("opens the flow when the write throws a payment error (reactive)", async () => {
    isPaymentError.mockReturnValue(true);
    const err = new Error("Invalid: Payment");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(guardedWrite(fn)).rejects.toBe(err);
    expect(triggerBecomeBuilder).toHaveBeenCalledTimes(1);
  });

  it("does NOT open the flow on a non-payment error", async () => {
    isPaymentError.mockReturnValue(false);
    const fn = vi.fn().mockRejectedValue(new Error("AlreadyExists"));
    await expect(guardedWrite(fn)).rejects.toThrow("AlreadyExists");
    expect(triggerBecomeBuilder).not.toHaveBeenCalled();
  });

  it("skips the pre-checks when not connected (lets the write/connect path handle it)", async () => {
    selectedAccount.current = null;
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(guardedWrite(fn)).resolves.toBe("ok");
    expect(isRevealedNow).not.toHaveBeenCalled();
    expect(hasSufficientFunds).not.toHaveBeenCalled();
  });
});
