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
import { registryEventTopic, type RegistryEventName } from "../utils/event-stream/registryEvents.ts";
import { deployXpAwardedFromEvents } from "./deployAward.ts";

const REGISTRY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Compact<u32> length prefix + utf8, modes 0 and 1 — enough for test domains. */
function encodeString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const len = utf8.length;
  const header =
    len < 0x40
      ? new Uint8Array([len << 2])
      : new Uint8Array([((len << 2) | 0b01) & 0xff, ((len << 2) >>> 8) & 0xff]);
  const out = new Uint8Array(header.length + utf8.length);
  out.set(header, 0);
  out.set(utf8, header.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** PointAwardEvent payload: recipient Address(20) + String(domain). */
function pointAwardData(domain: string): Uint8Array {
  return concat(new Uint8Array(20).fill(0x11), encodeString(domain));
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

const deployAwardEvent = () =>
  contractEmittedEvent({
    contract: REGISTRY,
    eventName: "DeployPointAwarded",
    data: pointAwardData("hello.dot"),
  });

describe("deployXpAwardedFromEvents", () => {
  it("detects a DeployPointAwarded event for the registry contract", () => {
    expect(deployXpAwardedFromEvents([deployAwardEvent()], REGISTRY)).toBe(true);
  });

  it("accepts the bare pallet-enum shape (no phase wrapper)", () => {
    const bare = deployAwardEvent().event;
    expect(deployXpAwardedFromEvents([bare], REGISTRY)).toBe(true);
  });

  it("finds the award among unrelated events", () => {
    const events = [
      { phase: { type: "ApplyExtrinsic", value: 0 }, event: { type: "System", value: { type: "ExtrinsicSuccess" } } },
      contractEmittedEvent({ contract: REGISTRY, eventName: "Published", data: new TextEncoder().encode("hello.dot") }),
      deployAwardEvent(),
    ];
    expect(deployXpAwardedFromEvents(events, REGISTRY)).toBe(true);
  });

  // The core honesty guarantee: a 3rd+ deploy lists the app (publish succeeds)
  // but emits NO DeployPointAwarded, so the UI must NOT claim XP.
  it("returns false when only a Published event is present (no award fired)", () => {
    const published = contractEmittedEvent({
      contract: REGISTRY,
      eventName: "Published",
      data: new TextEncoder().encode("hello.dot"),
    });
    expect(deployXpAwardedFromEvents([published], REGISTRY)).toBe(false);
  });

  it("ignores a DeployPointAwarded emitted by a different contract", () => {
    const foreign = contractEmittedEvent({
      contract: OTHER_CONTRACT,
      eventName: "DeployPointAwarded",
      data: pointAwardData("hello.dot"),
    });
    expect(deployXpAwardedFromEvents([foreign], REGISTRY)).toBe(false);
  });

  it("returns false (no throw) for non-Revive and malformed events", () => {
    const malformed = { event: { type: "Revive", value: { type: "ContractEmitted", value: { contract: REGISTRY } } } };
    const foreignPallet = { event: { type: "Balances", value: { type: "Transfer", value: {} } } };
    expect(deployXpAwardedFromEvents([malformed, foreignPallet, null, undefined, 42], REGISTRY)).toBe(false);
  });

  it("returns false for an empty event list", () => {
    expect(deployXpAwardedFromEvents([], REGISTRY)).toBe(false);
  });
});
