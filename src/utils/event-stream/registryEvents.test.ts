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
  REGISTRY_EVENT_NAMES,
  TYPED_PAYLOAD_EVENTS,
  contractEmittedPayloadsFromWatchValue,
  decodeRegistryEventData,
  decodeRegistryEventFromContractEmittedPayload,
  decodeRegistryEventFromTopic,
  registryEventNameForTopic,
  registryEventTopic,
} from "./registryEvents";

function encodeString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const len = utf8.length;
  let header: Uint8Array;
  if (len < 0x40) {
    header = new Uint8Array([len << 2]);
  } else if (len < 0x4000) {
    const tagged = (len << 2) | 0b01;
    header = new Uint8Array([tagged & 0xff, (tagged >>> 8) & 0xff]);
  } else {
    throw new Error("test helper only supports compact modes 0 and 1");
  }
  const out = new Uint8Array(header.length + utf8.length);
  out.set(header, 0);
  out.set(utf8, header.length);
  return out;
}

function address(byte: number): Uint8Array {
  return new Uint8Array(20).fill(byte);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const registryAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("registry event decoding", () => {
  it("knows every custom event the current contract emits", () => {
    expect(REGISTRY_EVENT_NAMES).toEqual([
      "Published",
      "Unpublished",
      "Rated",
      "RatingRemoved",
      "VisibilityChanged",
      "Pinned",
      "Unpinned",
      "DeployPointAwarded",
      "PlaygroundPublishPointAwarded",
      "ModdablePointAwarded",
      "ModPointAwarded",
      "StarPointAwarded",
      "StarPointRefunded",
      "IdentityLinked",
      "IdentityCleared",
      "IdentityBonusAwarded",
      "FaucetFailed",
    ]);
  });

  it("maps bare-name keccak topics back to event names", () => {
    const topic = registryEventTopic("Published");
    expect(registryEventNameForTopic(topic)).toBe("Published");
    expect(registryEventNameForTopic(topic.toUpperCase())).toBe("Published");
    expect(registryEventNameForTopic("0x" + "00".repeat(32))).toBeUndefined();
  });

  it("decodes raw domain events", () => {
    const decoded = decodeRegistryEventData(
      "Published",
      new TextEncoder().encode("hello.dot"),
    );
    expect(decoded).toMatchObject({
      name: "Published",
      payload: { domain: "hello.dot" },
      primaryDomain: "hello.dot",
    });
  });

  it("decodes identity events as recipient-only, never a domain (no String to decode)", () => {
    // Payload = Address(20) + root_pubkey([u8;32]). Crucially the 32 root bytes
    // must NOT be parsed as a Compact<u32> len + utf8 String — only the leading
    // address is read, and no `primaryDomain` is surfaced.
    const root = new Uint8Array(32).fill(0x99);
    const decoded = decodeRegistryEventData(
      "IdentityLinked",
      concat(address(0xab), root),
    );
    expect(decoded).toMatchObject({
      name: "IdentityLinked",
      primaryAccount: "0xabababababababababababababababababababab",
      payload: { recipient: "0xabababababababababababababababababababab" },
    });
    expect(decoded.primaryDomain).toBeUndefined();
  });

  it("decodes all identity events without throwing on the 32-byte root", () => {
    const root = new Uint8Array(32).fill(0x00); // a zero root must not break decode
    for (const name of [
      "IdentityLinked",
      "IdentityCleared",
      "IdentityBonusAwarded",
    ] as const) {
      const decoded = decodeRegistryEventData(name, concat(address(0xcd), root));
      expect(decoded.name).toBe(name);
      expect(decoded.primaryDomain).toBeUndefined();
      expect(decoded.payload).toMatchObject({
        recipient: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      });
    }
  });

  it("tags the bonus identity event with pointDelta:1 (drives the XP celebration)", () => {
    // Regression guard: celebrationForEvent gates on pointDelta === 1, so the
    // award event MUST carry it from the real decoder — otherwise the XP
    // confetti silently never fires. Reveal (IdentityBonusAwarded) awards;
    // Linked/Cleared are not awards and must stay pointDelta-less.
    const root = new Uint8Array(32).fill(0x99);
    expect(
      decodeRegistryEventData("IdentityBonusAwarded", concat(address(0xcd), root)).pointDelta,
    ).toBe(1);
    expect(
      decodeRegistryEventData("IdentityLinked", concat(address(0xcd), root)).pointDelta,
    ).toBeUndefined();
    expect(
      decodeRegistryEventData("IdentityCleared", concat(address(0xcd), root)).pointDelta,
    ).toBeUndefined();
  });

  it("decodes point award payloads with recipient and domain", () => {
    const decoded = decodeRegistryEventData(
      "DeployPointAwarded",
      concat(address(0xaa), encodeString("launch.dot")),
    );
    expect(decoded).toMatchObject({
      name: "DeployPointAwarded",
      primaryAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      primaryDomain: "launch.dot",
      pointDelta: 1,
      payload: {
        recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        domain: "launch.dot",
        pointDelta: 1,
      },
    });
  });

  it("decodes mod point payloads using source domain as primary domain", () => {
    const decoded = decodeRegistryEventData(
      "ModPointAwarded",
      concat(
        address(0xbb),
        encodeString("parent.dot"),
        address(0xcc),
        encodeString("fork.dot"),
      ),
    );
    expect(decoded).toMatchObject({
      name: "ModPointAwarded",
      primaryAccount: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      primaryDomain: "parent.dot",
      pointDelta: 1,
      payload: {
        recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceDomain: "parent.dot",
        modder: "0xcccccccccccccccccccccccccccccccccccccccc",
        modDomain: "fork.dot",
      },
    });
  });

  it("decodes FaucetFailed as recipient-only (no domain, no pointDelta)", () => {
    // Payload = recipient: Address(20) + amount: u128 (16 bytes LE). Only the
    // recipient is surfaced (as primaryAccount) so the connected user's own dry
    // faucet can be matched; there is no String/domain and no XP movement.
    const amount = new Uint8Array(16);
    amount[0] = 0x10; // little-endian low byte — value doesn't matter here
    const decoded = decodeRegistryEventData(
      "FaucetFailed",
      concat(address(0xab), amount),
    );
    expect(decoded).toMatchObject({
      name: "FaucetFailed",
      primaryAccount: "0xabababababababababababababababababababab",
      payload: { recipient: "0xabababababababababababababababababababab", amount: 0x10n },
    });
    expect(decoded.primaryDomain).toBeUndefined();
    expect(decoded.pointDelta).toBeUndefined();
  });

  it("decodes star refunds as negative point movement", () => {
    const decoded = decodeRegistryEventData(
      "StarPointRefunded",
      concat(address(0xdd), encodeString("starred.dot"), address(0xee)),
    );
    expect(decoded).toMatchObject({
      name: "StarPointRefunded",
      primaryAccount: "0xdddddddddddddddddddddddddddddddddddddddd",
      primaryDomain: "starred.dot",
      pointDelta: -1,
      payload: {
        recipient: "0xdddddddddddddddddddddddddddddddddddddddd",
        domain: "starred.dot",
        voter: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        pointDelta: -1,
      },
    });
  });

  it("decodes from a topic and ignores unknown topics", () => {
    const decoded = decodeRegistryEventFromTopic(
      registryEventTopic("IdentityCleared"),
      concat(address(0xee), new Uint8Array(32)),
    );
    expect(decoded?.name).toBe("IdentityCleared");
    expect(decodeRegistryEventFromTopic("0x" + "11".repeat(32), new Uint8Array())).toBeNull();
  });

  it("marks only SCALE String-payload events as typed (identity events stay OUT)", () => {
    // Membership drives `decodeFirstDomainAfterAddress` in the dispatcher.
    // Identity events have no String field, so they must NOT be typed —
    // otherwise the 32-byte root would be misparsed as a length+utf8 String.
    expect(TYPED_PAYLOAD_EVENTS.has("DeployPointAwarded")).toBe(true);
    expect(TYPED_PAYLOAD_EVENTS.has("ModPointAwarded")).toBe(true);
    expect(TYPED_PAYLOAD_EVENTS.has("IdentityLinked")).toBe(false);
    expect(TYPED_PAYLOAD_EVENTS.has("IdentityCleared")).toBe(false);
    expect(TYPED_PAYLOAD_EVENTS.has("IdentityBonusAwarded")).toBe(false);
    expect(TYPED_PAYLOAD_EVENTS.has("Published")).toBe(false);
    // FaucetFailed also has no String field (recipient + u128) — must stay OUT.
    expect(TYPED_PAYLOAD_EVENTS.has("FaucetFailed")).toBe(false);
  });

  it("extracts only best-block ContractEmitted payload batches", () => {
    const payload = {
      contract: address(0xaa),
      topics: [registryEventTopic("Published")],
      data: new TextEncoder().encode("hello.dot"),
    };

    expect(contractEmittedPayloadsFromWatchValue({ type: "new", events: [{ payload }] }))
      .toEqual([payload]);
    expect(contractEmittedPayloadsFromWatchValue({ type: "finalized", events: [{ payload }] }))
      .toEqual([]);
    expect(contractEmittedPayloadsFromWatchValue({ type: "drop", events: [{ payload }] })).toEqual([]);
  });

  it("decodes Revive.ContractEmitted payloads for the registry contract", () => {
    const decoded = decodeRegistryEventFromContractEmittedPayload(
      {
        contract: address(0xaa),
        topics: [registryEventTopic("Published").toUpperCase()],
        data: new TextEncoder().encode("hello.dot"),
      },
      registryAddress,
    );

    expect(decoded).toMatchObject({
      name: "Published",
      payload: { domain: "hello.dot" },
      primaryDomain: "hello.dot",
    });

    expect(decodeRegistryEventFromContractEmittedPayload(
      {
        contract: address(0xbb),
        topics: [registryEventTopic("Published")],
        data: new TextEncoder().encode("other.dot"),
      },
      registryAddress,
    )).toBeNull();
  });
});
