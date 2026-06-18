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

import { describe, it, expect, vi } from "vitest";
import { resolveUsernames, ZERO_ROOT } from "./peopleIdentity";

const A = ("0x" + "11".repeat(32)) as `0x${string}`;
const B = ("0x" + "22".repeat(32)) as `0x${string}`;
const C = ("0x" + "33".repeat(32)) as `0x${string}`;
const D = ("0x" + "44".repeat(32)) as `0x${string}`;

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("resolveUsernames", () => {
  it("maps bound roots to a name, skips zero roots, never queries zeros", async () => {
    // Consumers value shape (paseo_individuality): full_username / lite_username
    // are raw UTF-8 byte arrays, not decoded strings.
    const getValues = vi.fn(async (keys: [string][]) =>
      keys.map(([acct]) =>
        acct === A
          ? {
              identifier_key: "0x",
              full_username: utf8("alice.dot"),
              lite_username: new Uint8Array(),
              credibility: { type: "Lite" as const, value: undefined },
            }
          : undefined,
      ),
    );
    const client = { query: { Resources: { Consumers: { getValues } } } };
    const out = await resolveUsernames(client as never, [A, ZERO_ROOT, B]);
    expect(out.get(A)).toBe("alice.dot");
    expect(out.get(ZERO_ROOT)).toBeNull();
    expect(out.get(B)).toBeNull();
    // Zero root is never passed to the host.
    expect(getValues).toHaveBeenCalledWith([[A], [B]]);
  });

  it("prefers full_username, falls back to lite_username, else null", async () => {
    const getValues = vi.fn(async (keys: [string][]) =>
      keys.map(([acct]) => {
        if (acct === A)
          return {
            identifier_key: "0x",
            full_username: utf8("alice.dot"),
            lite_username: utf8("alice-lite"),
            credibility: { type: "Lite" as const, value: undefined },
          };
        if (acct === B)
          return {
            identifier_key: "0x",
            full_username: undefined,
            lite_username: utf8("bob-lite"),
            credibility: { type: "Lite" as const, value: undefined },
          };
        if (acct === C)
          // bound but no name at all (both empty)
          return {
            identifier_key: "0x",
            full_username: undefined,
            lite_username: new Uint8Array(),
            credibility: { type: "Lite" as const, value: undefined },
          };
        return undefined; // D: no consumer entry
      }),
    );
    const client = { query: { Resources: { Consumers: { getValues } } } };
    const out = await resolveUsernames(client as never, [A, B, C, D]);
    expect(out.get(A)).toBe("alice.dot");
    expect(out.get(B)).toBe("bob-lite");
    expect(out.get(C)).toBeNull();
    expect(out.get(D)).toBeNull();
  });

  it("returns an all-null map without touching the host when every root is zero", async () => {
    const getValues = vi.fn();
    const client = { query: { Resources: { Consumers: { getValues } } } };
    const out = await resolveUsernames(client as never, [ZERO_ROOT, ZERO_ROOT]);
    expect(out.get(ZERO_ROOT)).toBeNull();
    expect(getValues).not.toHaveBeenCalled();
  });

  it("returns an empty map for an empty input", async () => {
    const getValues = vi.fn();
    const client = { query: { Resources: { Consumers: { getValues } } } };
    const out = await resolveUsernames(client as never, []);
    expect(out.size).toBe(0);
    expect(getValues).not.toHaveBeenCalled();
  });
});
