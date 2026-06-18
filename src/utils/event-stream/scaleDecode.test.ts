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
import {
  decodeCompactU32,
  decodeFaucetFailedEventPayload,
  decodeFirstDomainAfterAddress,
  decodeU128Le,
} from "./scaleDecode";

// Helpers ---------------------------------------------------------------------

/** Build the canonical SCALE encoding of a JS string: Compact<u32> len + utf8. */
function encodeString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const len = utf8.length;
  let header: Uint8Array;
  // Match the three Compact modes the decoder supports.
  if (len < 0x40) {
    header = new Uint8Array([len << 2]);
  } else if (len < 0x4000) {
    const tagged = (len << 2) | 0b01;
    header = new Uint8Array([tagged & 0xff, (tagged >>> 8) & 0xff]);
  } else if (len < 0x4000_0000) {
    const tagged = (len << 2) | 0b10;
    header = new Uint8Array([
      tagged & 0xff,
      (tagged >>> 8) & 0xff,
      (tagged >>> 16) & 0xff,
      (tagged >>> 24) & 0xff,
    ]);
  } else {
    throw new Error("string too long for this test helper");
  }
  const out = new Uint8Array(header.length + utf8.length);
  out.set(header, 0);
  out.set(utf8, header.length);
  return out;
}

/** Build a 20-byte zero address (the value doesn't matter for these tests). */
const ADDR20 = new Uint8Array(20);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Tests -----------------------------------------------------------------------

describe("decodeCompactU32", () => {
  it("decodes mode-0 (1 byte, value < 64)", () => {
    // value 0
    expect(decodeCompactU32(new Uint8Array([0x00]), 0)).toEqual({ value: 0, size: 1 });
    // value 1
    expect(decodeCompactU32(new Uint8Array([0x04]), 0)).toEqual({ value: 1, size: 1 });
    // value 63 (max for mode 0)
    expect(decodeCompactU32(new Uint8Array([0xfc]), 0)).toEqual({ value: 63, size: 1 });
  });

  it("decodes mode-1 (2 bytes, 64 <= value < 16384)", () => {
    // value 64 — boundary
    // (64 << 2) | 0b01 = 0x101 → little-endian [0x01, 0x01]
    expect(decodeCompactU32(new Uint8Array([0x01, 0x01]), 0)).toEqual({ value: 64, size: 2 });
    // value 100
    // (100 << 2) | 1 = 401 = 0x191 → [0x91, 0x01]
    expect(decodeCompactU32(new Uint8Array([0x91, 0x01]), 0)).toEqual({ value: 100, size: 2 });
  });

  it("decodes mode-2 (4 bytes, 16384 <= value < 2^30)", () => {
    // value 16384 — boundary
    // (16384 << 2) | 0b10 = 65538 = 0x10002 → [0x02, 0x00, 0x01, 0x00]
    expect(decodeCompactU32(new Uint8Array([0x02, 0x00, 0x01, 0x00]), 0)).toEqual({
      value: 16384,
      size: 4,
    });
  });

  it("throws on mode-3 (big-int tagged)", () => {
    expect(() => decodeCompactU32(new Uint8Array([0x03]), 0)).toThrow(/mode 3/);
  });

  it("respects offset", () => {
    // Junk byte, then a mode-0 value 7.
    const buf = new Uint8Array([0xff, 0x1c]);
    expect(decodeCompactU32(buf, 1)).toEqual({ value: 7, size: 1 });
  });
});

describe("decodeFirstDomainAfterAddress", () => {
  it("extracts a short domain after the 20-byte recipient address (mode-0 length)", () => {
    // PointAwardEvent shape: Address(20) + String("hello.dot")
    const payload = concat(ADDR20, encodeString("hello.dot"));
    expect(decodeFirstDomainAfterAddress(payload)).toBe("hello.dot");
  });

  it("extracts the SOURCE domain from ModPointEvent (recipient + source + modder + mod_domain)", () => {
    // Critical: the dispatcher relies on the FIRST string being the source
    // domain, because that's the one whose mod_count incremented. If
    // someone reorders the struct fields in the contract, this test fails
    // and we catch the regression instead of silently refreshing the wrong
    // domain on every mod event.
    const payload = concat(
      ADDR20,                          // recipient (source app's owner)
      encodeString("parent.dot"),      // source_domain
      ADDR20,                          // modder
      encodeString("my-fork.dot"),     // mod_domain
    );
    expect(decodeFirstDomainAfterAddress(payload)).toBe("parent.dot");
  });

  it("extracts the domain from StarPointEvent (recipient + domain + voter)", () => {
    const payload = concat(
      ADDR20,                         // recipient (app's owner)
      encodeString("starred.dot"),    // domain
      ADDR20,                         // voter
    );
    expect(decodeFirstDomainAfterAddress(payload)).toBe("starred.dot");
  });

  it("handles a domain whose length needs mode-1 compact encoding (>=64 chars)", () => {
    const long = "a".repeat(80) + ".dot";
    const payload = concat(ADDR20, encodeString(long));
    expect(decodeFirstDomainAfterAddress(payload)).toBe(long);
  });

  it("returns the empty string when the first string is empty", () => {
    // The contract shouldn't emit an empty domain in practice (publish
    // rejects empty metadata_uri but not empty domain — defensive guard
    // for future-proofing).
    const payload = concat(ADDR20, encodeString(""));
    expect(decodeFirstDomainAfterAddress(payload)).toBe("");
  });

  it("decodes utf-8 multi-byte characters correctly", () => {
    // SCALE length is BYTE length, not code-point count. Make sure the
    // decoder doesn't slice on character boundaries.
    const payload = concat(ADDR20, encodeString("café.dot"));
    expect(decodeFirstDomainAfterAddress(payload)).toBe("café.dot");
  });
});

describe("decodeU128Le", () => {
  /** Encode a bigint as 16 little-endian bytes. */
  function u128(value: bigint): Uint8Array {
    const out = new Uint8Array(16);
    let v = value;
    for (let i = 0; i < 16; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  it("decodes zero", () => {
    expect(decodeU128Le(u128(0n), 0)).toEqual({ value: 0n, size: 16 });
  });

  it("decodes a multi-byte value little-endian", () => {
    expect(decodeU128Le(u128(100_000_000_000n), 0)).toEqual({ value: 100_000_000_000n, size: 16 });
  });

  it("decodes the u128 max", () => {
    const max = (1n << 128n) - 1n;
    expect(decodeU128Le(u128(max), 0)).toEqual({ value: max, size: 16 });
  });

  it("respects offset", () => {
    const buf = concat(new Uint8Array([0xff, 0xff]), u128(42n));
    expect(decodeU128Le(buf, 2)).toEqual({ value: 42n, size: 16 });
  });

  it("throws when truncated", () => {
    expect(() => decodeU128Le(new Uint8Array(8), 0)).toThrow(/u128/);
  });
});

describe("decodeFaucetFailedEventPayload", () => {
  /** FaucetEvent: recipient Address(20) + amount u128 (16 bytes LE). */
  function u128(value: bigint): Uint8Array {
    const out = new Uint8Array(16);
    let v = value;
    for (let i = 0; i < 16; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  it("decodes recipient + amount", () => {
    const recipient = new Uint8Array(20).fill(0xab);
    const payload = concat(recipient, u128(100_000_000_000n));
    expect(decodeFaucetFailedEventPayload(payload)).toEqual({
      recipient: ("0x" + "ab".repeat(20)) as `0x${string}`,
      amount: 100_000_000_000n,
    });
  });
});
