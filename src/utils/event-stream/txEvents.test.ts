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
import { registryEventTopic, type RegistryEventName } from "./registryEvents.ts";
import { faucetFailedFromEvents } from "./txEvents.ts";

const REGISTRY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** FaucetEvent payload: recipient Address(20) + amount u128 (16 bytes LE). */
function faucetFailedData(amount: bigint): Uint8Array {
  const amt = new Uint8Array(16);
  let v = amount;
  for (let i = 0; i < 16; i++) {
    amt[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return concat(new Uint8Array(20).fill(0x11), amt);
}

/** A phase-wrapped papi system event for Revive.ContractEmitted. */
function contractEmittedEvent(opts: {
  contract: string;
  eventName: RegistryEventName;
  data: Uint8Array;
}) {
  return {
    phase: { type: "ApplyExtrinsic", value: 1 },
    event: {
      type: "Revive",
      value: {
        type: "ContractEmitted",
        value: {
          contract: opts.contract,
          data: opts.data,
          topics: [registryEventTopic(opts.eventName)],
        },
      },
    },
    topics: [],
  };
}

const faucetFailedEvent = () =>
  contractEmittedEvent({
    contract: REGISTRY,
    eventName: "FaucetFailed",
    data: faucetFailedData(100_000_000_000n),
  });

describe("faucetFailedFromEvents", () => {
  it("detects a FaucetFailed event for the registry contract", () => {
    expect(faucetFailedFromEvents([faucetFailedEvent()], REGISTRY)).toBe(true);
  });

  it("accepts the bare pallet-enum shape (no phase wrapper)", () => {
    const bare = faucetFailedEvent().event;
    expect(faucetFailedFromEvents([bare], REGISTRY)).toBe(true);
  });

  it("finds the failure among unrelated events", () => {
    const events = [
      { phase: { type: "ApplyExtrinsic", value: 0 }, event: { type: "System", value: { type: "ExtrinsicSuccess" } } },
      contractEmittedEvent({ contract: REGISTRY, eventName: "Published", data: new TextEncoder().encode("hello.dot") }),
      faucetFailedEvent(),
    ];
    expect(faucetFailedFromEvents(events, REGISTRY)).toBe(true);
  });

  // The success case: a funded faucet sends tokens and emits NO FaucetFailed,
  // so the caller must NOT warn the user.
  it("returns false when no FaucetFailed is present", () => {
    const published = contractEmittedEvent({
      contract: REGISTRY,
      eventName: "Published",
      data: new TextEncoder().encode("hello.dot"),
    });
    expect(faucetFailedFromEvents([published], REGISTRY)).toBe(false);
  });

  it("ignores a FaucetFailed emitted by a different contract", () => {
    const foreign = contractEmittedEvent({
      contract: OTHER_CONTRACT,
      eventName: "FaucetFailed",
      data: faucetFailedData(100_000_000_000n),
    });
    expect(faucetFailedFromEvents([foreign], REGISTRY)).toBe(false);
  });

  it("returns false (no throw) for non-Revive and malformed events", () => {
    const malformed = { event: { type: "Revive", value: { type: "ContractEmitted", value: { contract: REGISTRY } } } };
    const foreignPallet = { event: { type: "Balances", value: { type: "Transfer", value: {} } } };
    expect(faucetFailedFromEvents([malformed, foreignPallet, null, undefined, 42], REGISTRY)).toBe(false);
  });

  it("returns false for an empty event list", () => {
    expect(faucetFailedFromEvents([], REGISTRY)).toBe(false);
  });
});
