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

// Lists a freshly-deployed builder site on the playground registry. Host
// accounts use the mobile-authenticated `publish()` scoring path, while the
// wallet-less dev account uses the ungated `publishDev()` path that records the
// listing without deploy XP.

import { contractsReady, registryReady } from "../utils/contracts.ts";
import { runTx } from "../utils/diagnostics.ts";
import { deployXpAwardedFromEvents } from "./deployAward.ts";
import { PLAYGROUND_URL } from "../config.ts";
import { storeBytes } from "./store.ts";
import { withDeadline, READ_DEADLINE_MS, SIGN_DEADLINE_MS } from "../utils/deadline.ts";
import type { ActiveAccount } from "./account.ts";

const ZERO_H160 = "0x0000000000000000000000000000000000000000" as const;

export interface RegistryListing {
    /** CID of the metadata JSON the registry entry points at. */
    metadataCid: string;
    /**
     * Whether launch XP actually landed. The contract pays it only for an
     * owner's first three fresh, scored deploys (4th+ = 0), regardless of
     * public/private visibility, so a successful publish does not imply XP.
     */
    xpAwarded: boolean;
}

// Resolve the registry address, then delegate to the pure detector. Split out
// to deployAward.ts so the decode logic stays unit-testable without the
// chain-connecting contracts.ts module.
async function deployXpAwarded(events: readonly unknown[]): Promise<boolean> {
    const { registryAddress } = await contractsReady;
    return deployXpAwardedFromEvents(events, registryAddress);
}

/**
 * Build the metadata JSON the Apps grid reads, upload it to Bulletin, then
 * submit the registry publish transaction.
 *
 * The metadata mirrors the shape `PublishModal` writes (see AppMetadata in
 * App.tsx), populated from the builder's "List in Apps" panel: `name` and
 * `description` (the card title + blurb), `tag` (category), and `icon_cid` /
 * `cover_cid` auto-picked from an image already on the page. No repository /
 * readme — a builder site has no GitHub origin, so `is_moddable` is false and
 * `modded_from` is empty (the publish call below passes both). `tag` defaults to
 * `"site"` when the caller passes none — that reserved tag is the dot-site
 * quest's detection signal (see `scanOwnedMods` in `utils/useTaskProgress.ts`)
 * and `displayTag` in App.tsx hides it from the Apps-grid category chips.
 *
 * Throws on failure. Callers treat that as non-fatal (the site is already
 * live via DotNS) and downgrade to a warning.
 */
export async function publishSiteToRegistry(params: {
    /** The label the deploy resolved; `.dot` is appended if missing. */
    domain: string;
    name: string;
    description?: string;
    tag?: string;
    /** Bulletin CID of an image already on the page; sets icon_cid + cover_cid. */
    iconCid?: string;
    /**
     * On-chain visibility for the registry entry. The deploy pipeline lists
     * every site as `VISIBILITY_PRIVATE` (shows in the owner's My Apps, hidden
     * from the public Apps grid); the opt-in "List in Apps" flip re-publishes
     * the same entry as `VISIBILITY_PUBLIC`.
     */
    visibility: number;
    account: ActiveAccount;
    onStatus?: (msg: string) => void;
}): Promise<RegistryListing> {
    const { domain, name, description, tag, iconCid, visibility, account, onStatus } = params;
    const fullDomain = domain.endsWith(".dot") ? domain : `${domain}.dot`;

    onStatus?.("Registry: preparing listing…");
    // Only emit fields that carry a value so the blob matches AppMetadata
    // cleanly. cover_cid mirrors icon_cid (it would fall back to it anyway).
    // `tag` defaults to the reserved "site" tag — the dot-site quest detection
    // signal — when the caller passes none.
    const metadata: Record<string, string> = { name };
    const desc = description?.trim();
    if (desc) metadata.description = desc;
    metadata.tag = tag?.trim() || "site";
    if (iconCid?.trim()) {
        metadata.icon_cid = iconCid.trim();
        metadata.cover_cid = iconCid.trim();
    }
    // readme is the longer detail-page body and renders as MARKDOWN. Mirror the
    // short description into it and always append the playground.dot credit, so
    // every builder-listed app carries the "Built with" badge even when the
    // user left the description blank.
    const credit = `_Built with [playground.dot](${PLAYGROUND_URL})_`;
    metadata.readme = desc ? `${desc}\n\n${credit}` : credit;
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
    const stored = await storeBytes({
        bytes: metadataBytes,
        signer: account.signer,
        label: "Registry metadata",
        viaHost: account.source === "host",
        onStatus: (s) => onStatus?.(`Registry: ${s}`),
    });

    onStatus?.("Registry: publishing…");
    // Both awaits are deadline-bound. Unlike the deploy pipeline, this opt-in
    // listing path had no timeout net: `registryReady` can hang if the boot
    // chain handshake stalled, and the `publish` tx can hang on a wedged host
    // bridge — either would pin the "Listing…" button busy forever with no
    // recovery. A thrown DeadlineError instead reverts the button to a
    // retryable state (the site is already live; listing re-runs cleanly).
    const registry = await withDeadline(registryReady, READ_DEADLINE_MS, "Registry connection");
    const result = await withDeadline(
        account.source === "dev"
            ? registry.publishDev.tx(
                  fullDomain,
                  stored.cid,
                  visibility,
                  { isSome: false, value: ZERO_H160 },
                  "",
                  false,
                  { signer: account.signer, origin: account.address },
              ) as Promise<{ ok: boolean; events: unknown[] }>
            : runTx<{ ok: boolean; events: unknown[] }>(
                  "publish",
                  // owner = None → contract records env::caller() (the connected user)
                  // as owner. modded_from = "" (not a mod), is_moddable = false (no
                  // repo), is_dev_signer = false (host account is the real user). This
                  // matches PublishModal's call; see its comment for the Option<Address>
                  // / plain-string `modded_from` rationale.
                  (opts) =>
                      registry.publish.tx(
                          fullDomain,
                          stored.cid,
                          visibility,
                          { isSome: false, value: ZERO_H160 },
                          "",
                          false,
                          false,
                          opts,
                      ) as Promise<{ ok: boolean; events: unknown[] }>,
                  { domain: fullDomain, source: "builder" },
              ),
        SIGN_DEADLINE_MS,
        "Registry publish",
    );
    if (!result.ok) throw new Error("Registry publish transaction failed");
    return { metadataCid: stored.cid, xpAwarded: await deployXpAwarded(result.events ?? []) };
}
