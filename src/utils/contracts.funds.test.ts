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

// contracts.ts has a module-load side-effect (contractsReady IIFE calls
// getChainAPI at import time, which throws outside a host container).
// Stub it with a controlled mock client so balances.ts can import
// contractsReady without blowing up in the Vitest/Node environment.
//
// vi.spyOn and vi.mock partial stubs both fail to intercept within-module
// calls from hasSufficientFunds to getNativeBalance/getPgasBalance (native
// ESM live-binding limitation). The correct approach is to mock the chain
// client that the readers call, giving us full control over returned balances.

const mockAssetsAccountGetValue = vi.fn();
const mockSystemAccountGetValue = vi.fn();

vi.mock("./contracts.ts", () => ({
  contractsReady: Promise.resolve({
    client: {
      assetHub: {
        query: {
          Assets: {
            Account: {
              getValue: (...args: unknown[]) => mockAssetsAccountGetValue(...args),
            },
          },
          System: {
            Account: {
              getValue: (...args: unknown[]) => mockSystemAccountGetValue(...args),
            },
          },
        },
      },
    },
  }),
}));

// Stub Sentry / telemetry so captureWarning doesn't blow up in Node
vi.mock("../lib/telemetry", () => ({
  captureWarning: vi.fn(),
  journeyTracker: { start: vi.fn(), complete: vi.fn(), fail: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasSufficientFunds, MIN_NATIVE_PLANCK, MIN_PGAS } from "./balances.ts";

describe("hasSufficientFunds", () => {
  beforeEach(() => {
    mockAssetsAccountGetValue.mockReset();
    mockSystemAccountGetValue.mockReset();
  });

  it("passes when native PAS >= MIN_NATIVE_PLANCK", async () => {
    // Native free balance = exactly at floor (3 PAS)
    mockSystemAccountGetValue.mockResolvedValue({ data: { free: MIN_NATIVE_PLANCK } });
    // PGAS balance = 0 (below MIN_PGAS)
    mockAssetsAccountGetValue.mockResolvedValue({ balance: 0n });
    expect(await hasSufficientFunds({ address: "x" } as any)).toBe(true);
  });

  it("passes when PGAS >= MIN_PGAS even if native is low", async () => {
    // Native free balance = 0 (below MIN_NATIVE_PLANCK)
    mockSystemAccountGetValue.mockResolvedValue({ data: { free: 0n } });
    // PGAS balance = exactly at floor (5B units)
    mockAssetsAccountGetValue.mockResolvedValue({ balance: MIN_PGAS });
    expect(await hasSufficientFunds({ address: "x" } as any)).toBe(true);
  });

  it("fails when both are below floor", async () => {
    // Native free balance = 1B planck (below 3B floor)
    mockSystemAccountGetValue.mockResolvedValue({ data: { free: 1_000_000_000n } });
    // PGAS balance = 1B units (below 5B floor)
    mockAssetsAccountGetValue.mockResolvedValue({ balance: 1_000_000_000n });
    expect(await hasSufficientFunds({ address: "x" } as any)).toBe(false);
  });

  it("fails (conservative) when both reads fail (null from boundedRead)", async () => {
    // Both queries reject — boundedRead catches and returns null
    mockSystemAccountGetValue.mockRejectedValue(new Error("network error"));
    mockAssetsAccountGetValue.mockRejectedValue(new Error("network error"));
    expect(await hasSufficientFunds({ address: "x" } as any)).toBe(false);
  });
});
