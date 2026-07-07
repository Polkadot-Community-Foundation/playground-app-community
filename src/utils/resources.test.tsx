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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import type { SignerAccount } from "@parity/product-sdk-signer";

const hasPgasOnChain = vi.fn();
const provisionResources = vi.fn();
vi.mock("./contracts.ts", () => ({
  hasPgasOnChain: (...a: unknown[]) => hasPgasOnChain(...a),
  provisionResources: (...a: unknown[]) => provisionResources(...a),
}));

import {
  usePgasAllowance,
  requestResources,
  confirmResourcesGranted,
  type PgasAllowance,
} from "./resources";

const SNAPSHOT_KEY = "pg.resources.v1";
const H160 = "0xAbC0000000000000000000000000000000000001";
const ACCOUNT = {
  h160Address: H160,
  address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
} as unknown as SignerAccount;

function Probe({
  account,
  api,
}: {
  account?: SignerAccount;
  api: { current: PgasAllowance | null };
}) {
  const value = usePgasAllowance(account);
  api.current = value;
  return <div data-testid="probe" data-has={String(value.hasResources)} />;
}

function seedSnapshot(h160: string, value: boolean) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ [h160.toLowerCase()]: value }));
}

describe("usePgasAllowance", () => {
  beforeEach(() => {
    localStorage.clear();
    hasPgasOnChain.mockReset();
    provisionResources.mockReset();
  });
  afterEach(cleanup);

  it("seeds true synchronously from the snapshot and skips the chain read", async () => {
    seedSnapshot(H160, true);
    hasPgasOnChain.mockResolvedValue(false); // would say "no" — must not be consulted
    const api = { current: null as PgasAllowance | null };

    await act(async () => {
      render(<Probe account={ACCOUNT} api={api} />);
    });

    expect(screen.getByTestId("probe").dataset.has).toBe("true");
    // Cached-true short-circuits — PGAS persists, so no read can change it.
    expect(hasPgasOnChain).not.toHaveBeenCalled();
  });

  it("flips to true and persists when the chain read resolves true", async () => {
    hasPgasOnChain.mockResolvedValue(true);
    const api = { current: null as PgasAllowance | null };

    await act(async () => {
      render(<Probe account={ACCOUNT} api={api} />);
    });

    expect(api.current?.hasResources).toBe(true);
    const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}");
    expect(stored[H160.toLowerCase()]).toBe(true);
  });

  it("stays false when the read resolves false (no snapshot written)", async () => {
    hasPgasOnChain.mockResolvedValue(false);
    const api = { current: null as PgasAllowance | null };

    await act(async () => {
      render(<Probe account={ACCOUNT} api={api} />);
    });

    expect(api.current?.hasResources).toBe(false);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  it("flips the gate on refresh when resources are confirmed after mount", async () => {
    // Models the post-grant race: the initial chain read resolves false (PGAS
    // not yet indexed), so the gate mounts locked. An optimistic
    // confirmResourcesGranted + refresh must flip it without another chain read.
    hasPgasOnChain.mockResolvedValue(false);
    const api = { current: null as PgasAllowance | null };

    await act(async () => {
      render(<Probe account={ACCOUNT} api={api} />);
    });
    expect(api.current?.hasResources).toBe(false);

    await act(async () => {
      confirmResourcesGranted(H160);
      api.current?.refresh();
    });

    expect(api.current?.hasResources).toBe(true);
  });

  it("keeps a cached true and skips the read entirely", async () => {
    seedSnapshot(H160, true);
    hasPgasOnChain.mockResolvedValue(false); // would regress — must not be read
    const api = { current: null as PgasAllowance | null };

    await act(async () => {
      render(<Probe account={ACCOUNT} api={api} />);
    });

    expect(api.current?.hasResources).toBe(true);
    expect(hasPgasOnChain).not.toHaveBeenCalled();
  });
});

describe("confirmResourcesGranted", () => {
  beforeEach(() => localStorage.clear());

  it("writes the positive snapshot (one-way — never persists false)", () => {
    confirmResourcesGranted(H160);
    const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}");
    expect(stored[H160.toLowerCase()]).toBe(true);
  });
});

describe("requestResources", () => {
  beforeEach(() => provisionResources.mockReset());

  it("delegates to provisionResources (the batched-allowance + top-up flow)", async () => {
    provisionResources.mockResolvedValue(undefined);
    await requestResources();
    expect(provisionResources).toHaveBeenCalledTimes(1);
  });
});
