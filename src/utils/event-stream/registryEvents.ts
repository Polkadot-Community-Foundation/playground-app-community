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

import { keccak256, utf8ToBytes, bytesToHex } from "@parity/product-sdk-utils";
import {
  decodeAddress20,
  decodeFaucetFailedEventPayload,
  decodeModPointEventPayload,
  decodePointAwardEventPayload,
  decodeStarPointEventPayload,
  type FaucetFailedEventPayload,
  type ModPointEventPayload,
  type PointAwardEventPayload,
  type StarPointEventPayload,
} from "./scaleDecode";

export const RAW_DOMAIN_REGISTRY_EVENTS = [
  "Published",
  "Unpublished",
  "Rated",
  "RatingRemoved",
  "VisibilityChanged",
  "Pinned",
  "Unpinned",
] as const;

// `PlaygroundPublishPointAwarded` and `ModdablePointAwarded` were emitted
// alongside the legacy +1-per-bucket model. After #286 only DeployPointAwarded
// fires for a launch reward (single +100). The legacy names stay declared so
// historical events from a pre-redeploy contract still resolve to a name
// rather than silently dropping; no new emissions are expected.
export const POINT_AWARD_REGISTRY_EVENTS = [
  "DeployPointAwarded",
  "PlaygroundPublishPointAwarded",
  "ModdablePointAwarded",
] as const;

// `StarPointRefunded` was emitted by the legacy star-removal path where the
// owner's score went back down. The current model is one-way (no refund); the
// name is retained so historical refunds from older deployments still decode.
export const TYPED_REGISTRY_EVENTS = [
  ...POINT_AWARD_REGISTRY_EVENTS,
  "ModPointAwarded",
  "StarPointAwarded",
  "StarPointRefunded",
] as const;

// Verified-identity events (set_identity / clear_identity / first-reveal bonus).
// Payload = `IdentityEvent { recipient: Address(20 bytes), root_pubkey: [u8;32] }`
// — there is NO String/domain field. These MUST NOT be routed through the
// String/domain decoder (`decodeFirstDomainAfterAddress`): the 32-byte root
// would be misparsed as a Compact<u32> length + utf8 and either throw or yield
// garbage. They carry no domain at all — they exist to trigger a leaderboard /
// identity-display refresh. So they are deliberately kept OUT of
// `TYPED_PAYLOAD_EVENTS` and decoded into a payload with NO `primaryDomain`.
export const IDENTITY_REGISTRY_EVENTS = [
  "IdentityLinked",
  "IdentityCleared",
  "IdentityBonusAwarded",
] as const;

// Infra/health events. `FaucetFailed` fires when the contract-funded faucet is
// dry and could not send native PAS to `recipient` (the tx still reports `ok`).
// Payload = `FaucetEvent { recipient: Address(20 bytes), amount: u128 }` — no
// String/domain, so it stays OUT of `TYPED_PAYLOAD_EVENTS` for the same reason
// as the identity events. The recipient is surfaced as `primaryAccount` so the
// connected user's own dry-faucet can be matched and told it's on our side.
export const FAUCET_REGISTRY_EVENTS = ["FaucetFailed"] as const;

export const REGISTRY_EVENT_NAMES = [
  ...RAW_DOMAIN_REGISTRY_EVENTS,
  ...TYPED_REGISTRY_EVENTS,
  ...IDENTITY_REGISTRY_EVENTS,
  ...FAUCET_REGISTRY_EVENTS,
] as const;

export type RawDomainRegistryEventName = (typeof RAW_DOMAIN_REGISTRY_EVENTS)[number];
export type PointAwardRegistryEventName = (typeof POINT_AWARD_REGISTRY_EVENTS)[number];
export type TypedRegistryEventName = (typeof TYPED_REGISTRY_EVENTS)[number];
export type IdentityRegistryEventName = (typeof IDENTITY_REGISTRY_EVENTS)[number];
export type FaucetRegistryEventName = (typeof FAUCET_REGISTRY_EVENTS)[number];
export type RegistryEventName = (typeof REGISTRY_EVENT_NAMES)[number];

// The set of typed-payload (Address + String) event names, re-exported via
// `registryEventReducer` and asserted in tests. It no longer drives the decode
// path at runtime — routing is done by the per-class `*_EVENT_SET.has(name)`
// branches below. Identity events are intentionally absent — they have no
// String to decode (see IDENTITY_REGISTRY_EVENTS above).
export const TYPED_PAYLOAD_EVENTS: ReadonlySet<RegistryEventName> = new Set(TYPED_REGISTRY_EVENTS);

const RAW_DOMAIN_EVENT_SET: ReadonlySet<RegistryEventName> = new Set(RAW_DOMAIN_REGISTRY_EVENTS);
const POINT_AWARD_EVENT_SET: ReadonlySet<RegistryEventName> = new Set(POINT_AWARD_REGISTRY_EVENTS);
const IDENTITY_EVENT_SET: ReadonlySet<RegistryEventName> = new Set(IDENTITY_REGISTRY_EVENTS);
const FAUCET_EVENT_SET: ReadonlySet<RegistryEventName> = new Set(FAUCET_REGISTRY_EVENTS);

export interface RawDomainRegistryEventPayload {
  domain: string;
}

/**
 * Identity events carry `recipient: Address` + `root_pubkey: [u8;32]` — no
 * domain/String. The UI only needs to react to "an identity changed", so we
 * keep just the recipient (used for the `concernsUser` per-account check) and
 * deliberately surface NO `primaryDomain`.
 */
export interface IdentityRegistryEventPayload {
  recipient: `0x${string}`;
}

export interface RegistryEventPayloadBase {
  pointDelta?: 1 | -1;
}

export type RegistryEventPayload =
  | (RawDomainRegistryEventPayload & RegistryEventPayloadBase)
  | (IdentityRegistryEventPayload & RegistryEventPayloadBase)
  | (PointAwardEventPayload & RegistryEventPayloadBase)
  | (ModPointEventPayload & RegistryEventPayloadBase)
  | (StarPointEventPayload & RegistryEventPayloadBase)
  | (FaucetFailedEventPayload & RegistryEventPayloadBase);

export interface DecodedRegistryEvent<N extends RegistryEventName = RegistryEventName> {
  name: N;
  topic: `0x${string}`;
  payload: RegistryEventPayload;
  /** Domain whose app/social state should be refreshed, when the event has one. */
  primaryDomain?: string;
  /** Account whose points/name changed, when the event has one. */
  primaryAccount?: `0x${string}`;
  /** XP movement represented by this event, when the event is points-related. */
  pointDelta?: 1 | -1;
}

export interface ContractEmittedPayload {
  contract: unknown;
  topics?: readonly unknown[];
  data: unknown;
}

interface ContractEmittedWatchEvent {
  payload?: ContractEmittedPayload;
}

interface ContractEmittedWatchValue {
  type?: "new" | "drop" | "finalized";
  events?: readonly ContractEmittedWatchEvent[];
  payload?: ContractEmittedPayload;
}

export function registryEventTopic(name: RegistryEventName): `0x${string}` {
  return `0x${bytesToHex(keccak256(utf8ToBytes(name)))}` as `0x${string}`;
}

export const REGISTRY_EVENT_TOPICS: ReadonlyMap<string, RegistryEventName> = new Map(
  REGISTRY_EVENT_NAMES.map((name) => [registryEventTopic(name).toLowerCase(), name]),
);

export function registryEventNameForTopic(topicHex: string): RegistryEventName | undefined {
  return REGISTRY_EVENT_TOPICS.get(topicHex.toLowerCase());
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytesToPrefixedHex(bytes: Uint8Array | readonly number[]): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function toHex(v: unknown): string {
  if (typeof v === "string") {
    return v.startsWith("0x") || v.startsWith("0X") ? v : `0x${v}`;
  }
  if (v instanceof Uint8Array) return bytesToPrefixedHex(v);
  if (Array.isArray(v) && v.every((byte) => typeof byte === "number")) {
    return bytesToPrefixedHex(v);
  }

  const maybeHex = v as { toHex?: () => string; asHex?: () => string; asBytes?: () => unknown };
  const hex = maybeHex?.toHex?.() ?? maybeHex?.asHex?.();
  if (typeof hex === "string") return hex;

  const bytes = maybeHex?.asBytes?.();
  if (bytes instanceof Uint8Array) return bytesToPrefixedHex(bytes);

  return String(v);
}

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex byte string has odd length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function eventDataBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const asBytes = (data as { asBytes?: () => unknown })?.asBytes?.();
  if (asBytes instanceof Uint8Array) return asBytes;
  if (Array.isArray(data) && data.every((byte) => typeof byte === "number")) return new Uint8Array(data);
  if (typeof data === "string") return bytesFromHex(data);
  throw new Error("unsupported ContractEmitted data shape");
}

function isContractEmittedPayload(value: unknown): value is ContractEmittedPayload {
  return !!value && typeof value === "object" && "contract" in value && "data" in value;
}

function hasPayload(value: unknown): value is { payload: ContractEmittedPayload } {
  if (!value || typeof value !== "object" || !("payload" in value)) return false;
  return isContractEmittedPayload((value as { payload?: unknown }).payload);
}

export function contractEmittedPayloadsFromWatchValue(value: unknown): readonly ContractEmittedPayload[] {
  if (!value || typeof value !== "object") return [];
  const watchValue = value as ContractEmittedWatchValue;
  if (watchValue.type && watchValue.type !== "new") return [];

  if (Array.isArray(watchValue.events)) {
    return watchValue.events.flatMap((event) => hasPayload(event) ? [event.payload] : []);
  }

  return hasPayload(watchValue) ? [watchValue.payload] : [];
}

export function decodeRegistryEventFromContractEmittedPayload(
  payload: ContractEmittedPayload,
  registryAddress: string,
): DecodedRegistryEvent | null {
  const contractHex = toHex(payload.contract);
  if (contractHex.toLowerCase() !== registryAddress.toLowerCase()) return null;

  const topics = Array.isArray(payload.topics) ? payload.topics : [];
  if (topics.length === 0) return null;

  const topicHex = toHex(topics[0]).toLowerCase();
  return decodeRegistryEventFromTopic(topicHex, eventDataBytes(payload.data));
}

export function decodeRegistryEventData(
  name: RegistryEventName,
  bytes: Uint8Array,
): DecodedRegistryEvent {
  const topic = registryEventTopic(name);

  if (RAW_DOMAIN_EVENT_SET.has(name)) {
    const domain = decodeUtf8(bytes);
    return {
      name,
      topic,
      payload: { domain },
      primaryDomain: domain,
    };
  }

  if (IDENTITY_EVENT_SET.has(name)) {
    // Payload = Address(20) + root_pubkey([u8;32]). We only decode the leading
    // address (the recipient whose identity changed) and DO NOT touch the 32
    // root bytes — there is no String here, so we must not run the
    // domain/String decoder over them. No `primaryDomain` is surfaced.
    const recipient = decodeAddress20(bytes, 0);
    const base = {
      name,
      topic,
      payload: { recipient: recipient.value },
      primaryAccount: recipient.value,
    };
    // IdentityBonusAwarded (reveal) is the AWARDING identity event (+25 XP,
    // once-ever) — tag it pointDelta:1 so celebrationForEvent (which gates on
    // pointDelta === 1) fires the XP confetti. IdentityLinked / IdentityCleared
    // are plain state changes — no award, no pointDelta.
    return name === "IdentityBonusAwarded"
      ? { ...base, pointDelta: 1 as const }
      : base;
  }

  if (FAUCET_EVENT_SET.has(name)) {
    // Payload = recipient: Address(20) + amount: u128. No String/domain — only
    // the recipient matters, surfaced as primaryAccount so the connected user's
    // own dry-faucet can be matched. No pointDelta (this isn't an XP movement).
    const payload = decodeFaucetFailedEventPayload(bytes);
    return {
      name,
      topic,
      payload,
      primaryAccount: payload.recipient,
    };
  }

  if (POINT_AWARD_EVENT_SET.has(name)) {
    const payload = { ...decodePointAwardEventPayload(bytes), pointDelta: 1 as const };
    return {
      name,
      topic,
      payload,
      primaryDomain: payload.domain,
      primaryAccount: payload.recipient,
      pointDelta: 1,
    };
  }

  if (name === "ModPointAwarded") {
    const payload = { ...decodeModPointEventPayload(bytes), pointDelta: 1 as const };
    return {
      name,
      topic,
      payload,
      primaryDomain: payload.sourceDomain,
      primaryAccount: payload.recipient,
      pointDelta: 1,
    };
  }

  const starPayload = decodeStarPointEventPayload(bytes);
  const pointDelta: 1 | -1 = name === "StarPointRefunded" ? -1 : 1;
  const payload = { ...starPayload, pointDelta };
  return {
    name,
    topic,
    payload,
    primaryDomain: payload.domain,
    primaryAccount: payload.recipient,
    pointDelta,
  };
}

export function decodeRegistryEventFromTopic(
  topicHex: string,
  bytes: Uint8Array,
): DecodedRegistryEvent | null {
  const name = registryEventNameForTopic(topicHex);
  return name ? decodeRegistryEventData(name, bytes) : null;
}
