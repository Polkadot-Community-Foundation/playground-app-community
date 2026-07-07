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

import {
  type EventStreamEntity,
  type EventStreamInput,
  type EventStreamItem,
  type EventStreamSource,
} from "./eventStream";
import type {
  DecodedRegistryEvent,
  RegistryEventName,
  RegistryEventPayload,
} from "./registryEvents";
import { displayNameForAccount } from "../username";
import { XP_VALUES } from "../../xpValues";

export const REGISTRY_EVENT_STREAM_SOURCE_ID = "registry-contract";

function accountDisplayName(account: string): string {
  return displayNameForAccount(null, account);
}

function domainEntity(domain: string | undefined): EventStreamEntity[] {
  return domain ? [{ type: "domain", id: domain, label: domain }] : [];
}

function accountEntity(account: string | undefined): EventStreamEntity[] {
  return account ? [{ type: "account", id: account, label: accountDisplayName(account) }] : [];
}

function payloadDomain(payload: RegistryEventPayload): string | undefined {
  return "domain" in payload ? payload.domain : undefined;
}

function modPayload(payload: RegistryEventPayload): {
  sourceDomain: string;
  modDomain: string;
  modder: `0x${string}`;
} | null {
  return "sourceDomain" in payload && "modDomain" in payload && "modder" in payload
    ? {
      sourceDomain: payload.sourceDomain,
      modDomain: payload.modDomain,
      modder: payload.modder,
    }
    : null;
}

function streamKind(name: RegistryEventName): string {
  return `registry.${name}`;
}

export function registryEventToStreamInput(
  event: DecodedRegistryEvent,
): EventStreamInput<DecodedRegistryEvent> {
  const domain = event.primaryDomain ?? payloadDomain(event.payload);
  const recipient = event.primaryAccount;
  const mod = modPayload(event.payload);

  switch (event.name) {
    case "Published":
      return {
        kind: streamKind(event.name),
        category: "app",
        tone: "positive",
        title: "App published",
        detail: domain ? `${domain} was published to the registry.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "Unpublished":
      return {
        kind: streamKind(event.name),
        category: "app",
        tone: "warning",
        title: "App unpublished",
        detail: domain ? `${domain} was removed from the registry.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "VisibilityChanged":
      return {
        kind: streamKind(event.name),
        category: "app",
        tone: "neutral",
        title: "Visibility changed",
        detail: domain ? `${domain} changed visibility.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "Pinned":
      return {
        kind: streamKind(event.name),
        category: "admin",
        tone: "positive",
        title: "App pinned",
        detail: domain ? `${domain} was pinned.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "Unpinned":
      return {
        kind: streamKind(event.name),
        category: "admin",
        tone: "neutral",
        title: "App unpinned",
        detail: domain ? `${domain} was unpinned.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "Rated":
      return {
        kind: streamKind(event.name),
        category: "social",
        tone: "positive",
        title: "Review submitted",
        detail: domain ? `${domain} received a legacy review.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "RatingRemoved":
      return {
        kind: streamKind(event.name),
        category: "social",
        tone: "neutral",
        title: "Review removed",
        detail: domain ? `A legacy review was removed from ${domain}.` : undefined,
        entities: domainEntity(domain),
        payload: event,
      };
    case "DeployPointAwarded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "positive",
        title: "Deploy XP awarded",
        detail: domain && recipient
          ? `${accountDisplayName(recipient)} earned +${XP_VALUES.deploy} XP for deploying ${domain}.`
          : undefined,
        entities: [...domainEntity(domain), ...accountEntity(recipient)],
        payload: event,
      };
    // Legacy: pre-#286 contracts emitted these alongside DeployPointAwarded
    // (the +2 launch / +1 moddable split). Post-redeploy they never fire,
    // so these cases only render historical events from older deployments.
    case "PlaygroundPublishPointAwarded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "positive",
        title: "Playground XP awarded (legacy)",
        detail: domain && recipient ? `${accountDisplayName(recipient)} earned legacy publish XP for ${domain}.` : undefined,
        entities: [...domainEntity(domain), ...accountEntity(recipient)],
        payload: event,
      };
    case "ModdablePointAwarded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "positive",
        title: "Moddable XP awarded (legacy)",
        detail: domain && recipient ? `${accountDisplayName(recipient)} earned legacy moddable XP for ${domain}.` : undefined,
        entities: [...domainEntity(domain), ...accountEntity(recipient)],
        payload: event,
      };
    case "ModPointAwarded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "positive",
        title: "Mod XP awarded",
        detail: mod && recipient
          ? `${accountDisplayName(recipient)} earned +${XP_VALUES.modReceived} XP when ${mod.modDomain} modded ${mod.sourceDomain}.`
          : undefined,
        entities: [
          ...domainEntity(mod?.sourceDomain),
          ...domainEntity(mod?.modDomain),
          ...accountEntity(recipient),
          ...accountEntity(mod?.modder),
        ],
        payload: event,
      };
    case "StarPointAwarded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "positive",
        title: domain ? `${domain} received a star` : "Star XP awarded",
        detail: domain && recipient
          ? `${accountDisplayName(recipient)} earned +${XP_VALUES.starReceived} XP from a star on ${domain}.`
          : undefined,
        entities: [...domainEntity(domain), ...accountEntity(recipient)],
        payload: event,
      };
    // Legacy: pre-#287 contracts refunded star XP on star removal. The current
    // model is one-way (no refund); this case stays so historical refunds from
    // older deployments still render.
    case "StarPointRefunded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "negative",
        title: domain ? `Star removed from ${domain}` : "Star XP refunded (legacy)",
        detail: domain && recipient ? `${accountDisplayName(recipient)} lost legacy star XP after a star removal on ${domain}.` : undefined,
        entities: [...domainEntity(domain), ...accountEntity(recipient)],
        payload: event,
      };
    // Verified-identity events carry only the recipient (Address) + root pubkey
    // — no username/domain on the wire. The DotNS name resolves off-chain, so
    // the ticker shows the account, not a handle.
    case "IdentityLinked":
      return {
        kind: streamKind(event.name),
        category: "identity",
        tone: "positive",
        title: "Became a builder",
        detail: recipient
          ? `${accountDisplayName(recipient)} became a builder.`
          : undefined,
        entities: accountEntity(recipient),
        payload: event,
      };
    case "IdentityCleared":
      return {
        kind: streamKind(event.name),
        category: "identity",
        tone: "neutral",
        title: "Identity cleared",
        detail: recipient
          ? `${accountDisplayName(recipient)} reverted to anonymous.`
          : undefined,
        entities: accountEntity(recipient),
        payload: event,
      };
    case "IdentityBonusAwarded":
      return {
        kind: streamKind(event.name),
        category: "points",
        tone: "positive",
        title: "Builder bonus awarded",
        detail: recipient
          ? `${accountDisplayName(recipient)} earned +${XP_VALUES.identity} XP for becoming a builder.`
          : undefined,
        entities: accountEntity(recipient),
        payload: event,
      };
    // Infra/health: the contract-funded faucet ran dry and couldn't send native
    // tokens to the recipient. Recorded for ops visibility; the user-facing "it's
    // on us" message is surfaced from the faucet tx result, not this stream item.
    case "FaucetFailed":
      return {
        kind: streamKind(event.name),
        category: "admin",
        tone: "negative",
        title: "Faucet is empty",
        detail: recipient
          ? `The playground couldn't fund ${accountDisplayName(recipient)}.`
          : undefined,
        entities: accountEntity(recipient),
        payload: event,
      };
  }
}

export function createRegistryEventStreamSource(): EventStreamSource {
  return {
    id: REGISTRY_EVENT_STREAM_SOURCE_ID,
    label: "Registry contract",
    connect({ emit, error }) {
      let cancelled = false;
      let unsubscribe: (() => void) | undefined;

      import("./registryEventSubscription")
        .then(({ subscribeToRegistryEvents }) => {
          if (cancelled) return;
          unsubscribe = subscribeToRegistryEvents((event) => {
            emit(registryEventToStreamInput(event));
          });
        })
        .catch((err) => error(err, "failed to load registry event subscription"));

      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    },
  };
}

export function isRegistryEventStreamItem(
  item: EventStreamItem,
): item is EventStreamItem<DecodedRegistryEvent> {
  const payload = item.payload as Partial<DecodedRegistryEvent> | undefined;
  return item.source === REGISTRY_EVENT_STREAM_SOURCE_ID && typeof payload?.name === "string";
}
