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

/**
 * Minimal SCALE decoder for the registry contract's typed event payloads.
 *
 * Two event payload shapes coexist on the registry. The legacy events
 * (Published / Unpublished / Rated / RatingRemoved / VisibilityChanged /
 * Pinned / Unpinned) emit raw UTF-8 domain bytes. The newer point/star/mod
 * events emit a SCALE-encoded struct via `emit_typed_event` — see
 * `contracts/registry/lib.rs`. The struct layout in `parity-scale-codec`
 * order is:
 *
 *   PointAwardEvent: Address(20 bytes) + String(Compact<u32> len + utf8)
 *   ModPointEvent:   Address + String(source) + Address(modder) + String(mod_domain)
 *   StarPointEvent:  Address + String(domain) + Address(voter)
 *
 * For social-count refresh we only need the FIRST string field, which
 * always sits at offset 20 (after the recipient address). For the mod
 * event, that first string is the SOURCE domain — the one whose
 * `mod_count` the contract just incremented — which is exactly what we
 * want to re-fetch.
 *
 * We hand-roll a tiny Compact<u32> + String decoder instead of pulling
 * scale-ts: domain lengths are tiny, three modes cover all real values,
 * and we avoid the dep cost. Mode 3 (BigUint-tagged) won't appear for
 * domain lengths in practice; we throw if it ever does so we notice.
 */

export function decodeCompactU32(
  bytes: Uint8Array,
  offset: number,
): { value: number; size: number } {
  if (offset < 0 || offset >= bytes.length) {
    throw new Error("compact u32 offset out of bounds");
  }
  const b0 = bytes[offset];
  const mode = b0 & 0b11;
  if (mode === 0) return { value: b0 >>> 2, size: 1 };
  if (mode === 1) {
    if (offset + 1 >= bytes.length) {
      throw new Error("compact u32 mode 1 truncated");
    }
    const b1 = bytes[offset + 1];
    return { value: (b0 | (b1 << 8)) >>> 2, size: 2 };
  }
  if (mode === 2) {
    if (offset + 3 >= bytes.length) {
      throw new Error("compact u32 mode 2 truncated");
    }
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];
    return {
      value: ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 2) >>> 0,
      size: 4,
    };
  }
  throw new Error("compact mode 3 (big int) not supported for event payloads");
}

function requireBytes(bytes: Uint8Array, offset: number, size: number, label: string): void {
  if (offset < 0 || size < 0 || offset + size > bytes.length) {
    throw new Error(`${label} truncated`);
  }
}

function bytesToHexLower(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out as `0x${string}`;
}

export function decodeAddress20(
  bytes: Uint8Array,
  offset: number,
): { value: `0x${string}`; size: 20 } {
  requireBytes(bytes, offset, 20, "address");
  return { value: bytesToHexLower(bytes.subarray(offset, offset + 20)), size: 20 };
}

export function decodeU128Le(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; size: 16 } {
  requireBytes(bytes, offset, 16, "u128");
  let value = 0n;
  for (let i = 15; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return { value, size: 16 };
}

export function decodeScaleString(
  bytes: Uint8Array,
  offset: number,
): { value: string; size: number } {
  const { value: len, size: lenSize } = decodeCompactU32(bytes, offset);
  const start = offset + lenSize;
  const end = start + len;
  requireBytes(bytes, start, len, "string");
  return {
    value: new TextDecoder().decode(bytes.subarray(start, end)),
    size: lenSize + len,
  };
}

export interface PointAwardEventPayload {
  recipient: `0x${string}`;
  domain: string;
}

export interface ModPointEventPayload {
  recipient: `0x${string}`;
  sourceDomain: string;
  modder: `0x${string}`;
  modDomain: string;
}

export interface StarPointEventPayload {
  recipient: `0x${string}`;
  domain: string;
  voter: `0x${string}`;
}

export interface FaucetFailedEventPayload {
  recipient: `0x${string}`;
  /** Native-token amount (planck) the dry faucet failed to send. */
  amount: bigint;
}

export function decodePointAwardEventPayload(bytes: Uint8Array): PointAwardEventPayload {
  const recipient = decodeAddress20(bytes, 0);
  const domain = decodeScaleString(bytes, recipient.size);
  return {
    recipient: recipient.value,
    domain: domain.value,
  };
}

export function decodeModPointEventPayload(bytes: Uint8Array): ModPointEventPayload {
  let offset = 0;
  const recipient = decodeAddress20(bytes, offset);
  offset += recipient.size;
  const sourceDomain = decodeScaleString(bytes, offset);
  offset += sourceDomain.size;
  const modder = decodeAddress20(bytes, offset);
  offset += modder.size;
  const modDomain = decodeScaleString(bytes, offset);
  return {
    recipient: recipient.value,
    sourceDomain: sourceDomain.value,
    modder: modder.value,
    modDomain: modDomain.value,
  };
}

export function decodeStarPointEventPayload(bytes: Uint8Array): StarPointEventPayload {
  let offset = 0;
  const recipient = decodeAddress20(bytes, offset);
  offset += recipient.size;
  const domain = decodeScaleString(bytes, offset);
  offset += domain.size;
  const voter = decodeAddress20(bytes, offset);
  return {
    recipient: recipient.value,
    domain: domain.value,
    voter: voter.value,
  };
}

export function decodeFaucetFailedEventPayload(bytes: Uint8Array): FaucetFailedEventPayload {
  const recipient = decodeAddress20(bytes, 0);
  const amount = decodeU128Le(bytes, recipient.size);
  return {
    recipient: recipient.value,
    amount: amount.value,
  };
}

/**
 * Extract the first `String` field from a SCALE-encoded typed event
 * payload that begins with a 20-byte Address. Pure; exported so the
 * dispatcher can route social-count refreshes by domain.
 */
export function decodeFirstDomainAfterAddress(bytes: Uint8Array): string {
  return decodeScaleString(bytes, 20).value;
}
