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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  confirmRegistryAddress,
  readPointsSnapshot,
  writePointsSnapshot,
  readLeaderboardSnapshot,
  writeLeaderboardSnapshot,
} from "./snapshotCache";

const ADDR = "0xAbCd000000000000000000000000000000000001";
const ACCOUNT = "0x1111111111111111111111111111111111111111";

const BREAKDOWN = {
  total: 165n,
  launch_points: 10n,
  mod_points: 1n,
  star_points: 3n,
};

describe("snapshotCache", () => {
  beforeEach(() => {
    localStorage.clear();
    // The module-level confirmed address survives across tests in a worker;
    // re-confirm explicitly per test for a known state.
    confirmRegistryAddress(ADDR);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a points breakdown with bigint values", () => {
    writePointsSnapshot(ACCOUNT, BREAKDOWN);
    expect(readPointsSnapshot(ACCOUNT)).toEqual(BREAKDOWN);
  });

  it("keys points snapshots per account, case-insensitively", () => {
    writePointsSnapshot(ACCOUNT.toUpperCase(), BREAKDOWN);
    expect(readPointsSnapshot(ACCOUNT)).toEqual(BREAKDOWN);
    expect(readPointsSnapshot("0x2222222222222222222222222222222222222222")).toBeNull();
  });

  it("round-trips a leaderboard page including null usernames", () => {
    const entries = [
      { account: ACCOUNT, score: 25n },
      { account: "0x2222222222222222222222222222222222222222", score: 10n },
    ];
    const usernames = new Map<string, string | null>([
      [ACCOUNT.toLowerCase(), "george"],
      ["0x2222222222222222222222222222222222222222", null],
    ]);
    writeLeaderboardSnapshot(entries, usernames);
    const snap = readLeaderboardSnapshot();
    expect(snap?.entries).toEqual(entries);
    expect(snap?.usernames).toEqual(usernames);
  });

  it("purges blobs written under another registry address on confirm", () => {
    writePointsSnapshot(ACCOUNT, BREAKDOWN);
    writeLeaderboardSnapshot([{ account: ACCOUNT, score: 1n }], new Map());
    confirmRegistryAddress("0x9999999999999999999999999999999999999999");
    expect(readPointsSnapshot(ACCOUNT)).toBeNull();
    expect(readLeaderboardSnapshot()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("keeps blobs whose address matches the confirmed one", () => {
    writePointsSnapshot(ACCOUNT, BREAKDOWN);
    confirmRegistryAddress(ADDR.toUpperCase()); // same address, different case
    expect(readPointsSnapshot(ACCOUNT)).toEqual(BREAKDOWN);
  });

  it("writes under the newly confirmed address after a switch", () => {
    const newAddr = "0x9999999999999999999999999999999999999999";
    confirmRegistryAddress(newAddr);
    writePointsSnapshot(ACCOUNT, BREAKDOWN);
    expect(readPointsSnapshot(ACCOUNT)).toEqual(BREAKDOWN);
    // The blob survives a re-confirm of the same address (not purged).
    confirmRegistryAddress(newAddr);
    expect(readPointsSnapshot(ACCOUNT)).toEqual(BREAKDOWN);
  });

  it("returns null for corrupt JSON and removes it on the next confirm", () => {
    localStorage.setItem(`playground:snapshot:v1:points:${ACCOUNT}`, "{not json");
    expect(readPointsSnapshot(ACCOUNT)).toBeNull();
    confirmRegistryAddress(ADDR);
    expect(localStorage.getItem(`playground:snapshot:v1:points:${ACCOUNT}`)).toBeNull();
  });

  it("returns null for non-numeric bigint payloads", () => {
    localStorage.setItem(
      `playground:snapshot:v1:points:${ACCOUNT}`,
      JSON.stringify({
        addr: ADDR.toLowerCase(),
        at: 0,
        data: { total: "lots", launch_points: "0", mod_points: "0", star_points: "0" },
      }),
    );
    expect(readPointsSnapshot(ACCOUNT)).toBeNull();
  });

  it("degrades silently when localStorage throws", () => {
    const getItem = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writePointsSnapshot(ACCOUNT, BREAKDOWN)).not.toThrow();
    expect(readPointsSnapshot(ACCOUNT)).toBeNull();
    expect(readLeaderboardSnapshot()).toBeNull();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("write is a no-op before the registry address is confirmed", async () => {
    // A fresh module instance has no confirmed address (the static import's
    // state was confirmed in beforeEach, so reset and re-import).
    vi.resetModules();
    const fresh = await import("./snapshotCache");
    fresh.writePointsSnapshot(ACCOUNT, BREAKDOWN);
    expect(localStorage.length).toBe(0);
    expect(fresh.readPointsSnapshot(ACCOUNT)).toBeNull();
  });

  it("ignores unrelated localStorage keys when purging", () => {
    localStorage.setItem("playground:permissions:v2:0xabc", "granted");
    confirmRegistryAddress("0x9999999999999999999999999999999999999999");
    expect(localStorage.getItem("playground:permissions:v2:0xabc")).toBe("granted");
  });
});
