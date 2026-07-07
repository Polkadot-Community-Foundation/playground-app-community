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

// Deploy orchestrator. Threads the three phases together:
//   1. Bulletin store via CloudStorageClient (data → CID)
//   2. DotNS register (label → owned)
//   3. DotNS setContenthash (CID ↔ label)
//
// Both account sources (host / dev) submit for real — readiness is judged
// up front by preflight.ts, not by gating the deploy path.

import { storeHTML, type StoreHTMLResult } from "./store.ts";
import { SUBMIT_DEADLINE_MS, withDeadline } from "../utils/deadline.ts";
import { getEvmAddress } from "./dotns/address.ts";
import { ensureAccountMapped } from "./dotns/contracts.ts";
import {
    checkDomainAvailability,
    commitDomain,
    finishRegistration,
    getDomainOwner,
    quoteDomain,
} from "./dotns/register.ts";
import { setContentHash } from "./dotns/content-hash.ts";
import { DOT_HOST } from "./config.ts";
import type { ActiveAccount } from "./account.ts";

export interface DeploySuccess {
    kind: "stored";
    bytes: number;
    cid: string;
    domain: string;
    url: string;
    gatewayUrl: string;
    /** Null on the host preimage route — the host doesn't report inclusion. */
    blockHash: string | null;
    blockNumber: number | null;
    /** True iff DotNS register + setContenthash both succeeded — `<name>.dot.li` resolves. */
    dotMapped: boolean;
    /** Reason DotNS failed, if it did. Null when dotMapped===true. */
    dotError: string | null;
}

export type StatusFn = (message: string) => void;

// ── Common helpers ──────────────────────────────────────────────────────────

// deriveDomain lives in src/derive-domain.ts (dependency-free) so the editor
// UI can use it without pulling this module's chain stack into the bundle.

// ── Real end-to-end deploy ──────────────────────────────────────────────────

// `finalLabel` is the already-resolved label (typed or auto-derived) — the
// caller resolves it once so pre-flight checks and the deploy agree on the
// exact name being registered.
export async function deployFull(
    html: string,
    finalLabel: string,
    account: ActiveAccount,
    onStatus: StatusFn,
): Promise<DeploySuccess> {
    // Pipelined: the DotNS commitment doesn't depend on the stored CID, so
    // for fresh names the Bulletin store runs CONCURRENTLY with the
    // protocol-mandated ~60s commitment age — removing the store entirely
    // from the critical path. Invariant preserved from the sequential
    // version: a store failure is a total failure (throw), while any DotNS
    // failure still returns partial success (`dotMapped: false`) so the
    // user keeps their CID and gateway URL.
    // The store reports terse DeployStatus tokens ("signing", "broadcasting",
    // …). Reword them so the line is honest about WHICH wait you're in: the
    // "awaiting signature" stretch is the host→remote-signer round-trip (the
    // part that timed out in the wild — "the remote signer did not respond"),
    // distinct from "broadcasting" once it's signed and on the wire. Keep the
    // raw tokens inside store.ts untouched — the image-upload bar matches them
    // literally (stepForUploadStatus); only the "Bulletin:"-prefixed deploy
    // line is reworded, and the prefix still routes it to the Store step.
    const prettifyBulletin = (s: string): string => {
        if (s === "signing") return "Bulletin: awaiting signature…";
        if (s.startsWith("signing chunk "))
            return `Bulletin: awaiting signature, ${s.slice("signing ".length)}…`;
        if (s === "broadcasting") return "Bulletin: broadcasting…";
        if (s === "in-block") return "Bulletin: confirming…";
        if (s === "finalized") return "Bulletin: stored";
        return `Bulletin: ${s}`;
    };
    const doStore = (): Promise<StoreHTMLResult> => {
        onStatus("Bulletin: connecting…");
        // Deadlined: on a host with a half-working chain backend the store
        // can hang forever (observed on the paseo.li gateway), and since it
        // runs concurrently with the commitment countdown the UI freezes on
        // the countdown's last tick with no error.
        return withDeadline(
            storeHTML({
                html,
                signer: account.signer,
                viaHost: account.source === "host",
                onStatus: (s) => onStatus(prettifyBulletin(s)),
            }),
            SUBMIT_DEADLINE_MS,
            "The Bulletin upload",
        );
    };
    const waitCommitmentAge = async (seconds: number, isCancelled: () => boolean) => {
        for (let remaining = seconds; remaining > 0; remaining--) {
            if (isCancelled()) return;
            onStatus(`DotNS register: Waiting ${remaining}s for your domain name…`);
            await new Promise((r) => setTimeout(r, 1000));
        }
        // The final "Waiting 1s…" would otherwise sit on screen well past its
        // one second — until the reveal tx (or the still-running concurrent
        // store) emits the next status. Swap it out the instant the wait is
        // over so the countdown doesn't read as stuck.
        if (!isCancelled()) onStatus("DotNS register: Domain name reserved…");
    };

    let stored: StoreHTMLResult;
    let dotMapped = false;
    let dotError: string | null = null;

    // ── Phase 1: DotNS prep (cheap dry-runs + commit tx). A failure here —
    // including "name belongs to someone else" — still delivers the bytes:
    // run the store and return partial success, matching the sequential
    // version's behavior.
    let commitment: Awaited<ReturnType<typeof commitDomain>> | null = null;
    try {
        onStatus("DotNS: resolving owner account…");
        const ownerEvmAddress = await getEvmAddress(account.address);

        onStatus("DotNS: checking domain availability…");
        const available = await checkDomainAvailability(finalLabel, account.address);

        if (!available) {
            // Taken — but if it's taken by THIS account, this is a content
            // update: skip the commit-reveal registration (and its 60s+
            // wait) and go straight to repointing the contenthash.
            const currentOwner = await getDomainOwner(finalLabel, account.address);
            if (!currentOwner || currentOwner.toLowerCase() !== ownerEvmAddress.toLowerCase()) {
                throw new Error(
                    `Domain ${finalLabel}.dot is already registered` +
                        (currentOwner ? ` to ${currentOwner}` : "") +
                        ` (your account maps to ${ownerEvmAddress}). Pick another name.`,
                );
            }
            onStatus("DotNS: domain name already yours, updating content…");
            // commitDomain normally handles the one-time H160 mapping;
            // the update path needs it ensured before the resolver call.
            await ensureAccountMapped(account.address, account.signer);
        } else {
            // Re-check registrability immediately before the first paid write.
            // A name can be "available" yet require a higher verification tier
            // than this account holds — registration would be rejected at the
            // reveal, AFTER the commitment tx (and the Bulletin store) are
            // already spent. Abort here so only the harmless store happens.
            const quote = await quoteDomain(finalLabel, ownerEvmAddress, account.address);
            if (
                quote.status !== null &&
                quote.userStatus !== null &&
                quote.userStatus < quote.status
            ) {
                throw new Error(
                    `${finalLabel}.dot requires verification tier ${quote.status}, but this account is tier ${quote.userStatus}` +
                        (quote.message ? ` ("${quote.message}")` : "") +
                        `. Pick another name.`,
                );
            }
            commitment = await commitDomain({
                label: finalLabel,
                ownerEvmAddress,
                signerAddress: account.address,
                signer: account.signer,
                onStatus: (s) => onStatus(`DotNS register: ${s}`),
            });
        }
    } catch (cause) {
        dotError = cause instanceof Error ? cause.message : String(cause);
        stored = await doStore();
        onStatus(`DotNS step failed; Bulletin store still succeeded. ${dotError}`);
        return {
            kind: "stored",
            bytes: stored.bytes,
            cid: stored.cid,
            domain: finalLabel,
            url: `https://${finalLabel}.${DOT_HOST}`,
            gatewayUrl: stored.ipfsUrl,
            blockHash: stored.blockHash,
            blockNumber: stored.blockNumber,
            dotMapped: false,
            dotError,
        };
    }

    // ── Phase 2: the store. For fresh names it runs CONCURRENTLY with the
    // commitment-age wait. A store failure here propagates as a TOTAL
    // failure (same contract as before) — the spent commitment expires
    // harmlessly on-chain.
    if (commitment) {
        // If the store rejects, Promise.all ABANDONS the wait rather than
        // cancelling it — without the flag, the orphaned loop keeps firing
        // status updates for up to ~66s, stomping the progress UI of any
        // retry the user starts. The finally flips the flag on every exit
        // path; the abandoned loop notices at its next 1s tick.
        let settled = false;
        try {
            [, stored] = await Promise.all([
                waitCommitmentAge(commitment.totalWait, () => settled),
                doStore(),
            ]);
        } finally {
            settled = true;
        }
    } else {
        stored = await doStore();
    }

    // ── Phase 3: reveal + point the name. Failures are partial success —
    // the user keeps their CID and gateway URL.
    try {
        if (commitment) {
            await finishRegistration({
                commitment,
                signerAddress: account.address,
                signer: account.signer,
                onStatus: (s) => onStatus(`DotNS register: ${s}`),
            });
        }
        await setContentHash({
            label: finalLabel,
            cidString: stored.cid,
            signerAddress: account.address,
            signer: account.signer,
            onStatus: (s) => onStatus(`DotNS resolver: ${s}`),
        });
        dotMapped = true;
    } catch (cause) {
        dotError = cause instanceof Error ? cause.message : String(cause);
        onStatus(`DotNS step failed; Bulletin store still succeeded. ${dotError}`);
    }

    return {
        kind: "stored",
        bytes: stored.bytes,
        cid: stored.cid,
        domain: finalLabel,
        url: `https://${finalLabel}.${DOT_HOST}`,
        gatewayUrl: stored.ipfsUrl,
        blockHash: stored.blockHash,
        blockNumber: stored.blockNumber,
        dotMapped,
        dotError,
    };
}
