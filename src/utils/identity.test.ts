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

import { describe, it, expect, vi, beforeEach } from "vitest";

// `identity.ts` imports `./contracts.ts`, whose module-load code connects to
// the chain + signer — which throws in the test env. Mock it (mirrors
// `username.test.ts`) so importing the message builder under test is inert.
vi.mock("./contracts.ts", () => ({
  contractsReady: Promise.resolve({}),
  individualityReady: Promise.resolve({}),
}));

import {
  buildIdentityMessage,
  readRevealedSnapshot,
  confirmRevealed,
  isRevealedNow,
} from "./identity";

describe("buildIdentityMessage", () => {
  it("lays out domain || contract(20) || caller(20), no <Bytes> wrap", () => {
    const c = ("0x" + "ab".repeat(20)) as `0x${string}`;
    const k = ("0x" + "cd".repeat(20)) as `0x${string}`;
    const m = buildIdentityMessage(c, k);
    const dlen = new TextEncoder().encode("playground.dot identity v1\n").length;
    expect(m.length).toBe(dlen + 40);
    expect(Array.from(m.slice(dlen, dlen + 20))).toEqual(Array(20).fill(0xab));
    expect(Array.from(m.slice(dlen + 20))).toEqual(Array(20).fill(0xcd));
    // sanity: no "<Bytes>" prefix
    expect(new TextDecoder().decode(m.slice(0, 7))).not.toBe("<Bytes>");
  });

  it("starts with the exact domain-separator string", () => {
    const c = ("0x" + "00".repeat(20)) as `0x${string}`;
    const k = ("0x" + "11".repeat(20)) as `0x${string}`;
    const m = buildIdentityMessage(c, k);
    const domain = "playground.dot identity v1\n";
    const dlen = new TextEncoder().encode(domain).length;
    expect(new TextDecoder().decode(m.slice(0, dlen))).toBe(domain);
  });
});

describe("revealed snapshot", () => {
  const A = "0x" + "ab".repeat(20);

  beforeEach(() => localStorage.clear());

  it("reads false for an unknown account", () => {
    expect(readRevealedSnapshot(A)).toBe(false);
  });

  it("records the positive and reads it back (case-insensitive)", () => {
    confirmRevealed(A.toUpperCase());
    expect(readRevealedSnapshot(A)).toBe(true);
    expect(readRevealedSnapshot(A.toUpperCase())).toBe(true);
  });

  it("is one-way — a second confirm never regresses a known positive", () => {
    confirmRevealed(A);
    confirmRevealed(A);
    expect(readRevealedSnapshot(A)).toBe(true);
  });

  it("isRevealedNow short-circuits true on a cached positive (no chain read)", async () => {
    confirmRevealed(A);
    await expect(isRevealedNow(A)).resolves.toBe(true);
  });
});
