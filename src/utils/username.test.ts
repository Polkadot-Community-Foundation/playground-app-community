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

import { describe, expect, it } from "vitest";

import {
  deterministicNameForAccount,
  displayNameForAccount,
  profilePathForAccount,
  resolveProfileIdentifier,
} from "./username";

describe("profilePathForAccount", () => {
  it("always routes by the H160 address (resolver is H160-only)", () => {
    expect(
      profilePathForAccount("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe("/profile/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("displayNameForAccount", () => {
  const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("prefers a registry username", () => {
    expect(displayNameForAccount("alice", account)).toBe("alice");
  });

  it("falls back to a deterministic hyphenated handle with a hex discriminator once the chain confirmed no username", () => {
    const name = displayNameForAccount(null, account);

    expect(name).toBe(deterministicNameForAccount(account));
    // "<descriptor>-<animal>-<hex>" — a valid claimable handle, identical to
    // what the reveal/anon flow claims (no space/# display variant).
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    expect(name).not.toContain("0x");
  });

  it("gives two distinct accounts distinct claimable handles (the hex tail keeps anon names unique)", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const b = "0x1111111111111111111111111111111111112222";
    expect(deterministicNameForAccount(a)).not.toBe(deterministicNameForAccount(b));
  });

  it("shows an ellipsis while the username is still unknown (#324)", () => {
    // undefined = the read hasn't succeeded yet. The generated name must
    // never paint over a possibly-set handle during loading or RPC failure.
    expect(displayNameForAccount(undefined, account)).toBe("…");
  });

  it("normalizes account casing before deriving the fallback", () => {
    expect(deterministicNameForAccount(account.toUpperCase())).toBe(
      deterministicNameForAccount(account),
    );
  });
});

describe("resolveProfileIdentifier", () => {
  it("accepts a raw H160 and normalizes its casing", async () => {
    const result = await resolveProfileIdentifier("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    expect(result).toEqual({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lookup: "address",
      normalizedInput: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("returns null for a non-H160 segment (profile URLs are H160-only now)", async () => {
    // Usernames moved to the People chain — there is no contract reverse index,
    // so a name segment no longer resolves to an owner.
    await expect(resolveProfileIdentifier("Alice")).resolves.toBeNull();
  });

  it("returns null for empty input", async () => {
    await expect(resolveProfileIdentifier("  ")).resolves.toBeNull();
  });
});
