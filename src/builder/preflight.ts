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

// Pre-flight checks for the deploy flow. Everything here is read-only —
// storage queries and pallet-revive dry-runs — so the checklist can run
// automatically (and repeatedly) at zero cost before the user commits to
// the irreversible deploy transactions.
//
// Severity model: "fail" blocks the Deploy button (deploying WOULD fail or
// waste a transaction), "warn" does not (we couldn't verify, or deploy can
// recover — e.g. the one-time map_account setup). A flaky RPC must never
// lock the user out of deploying: checks that throw degrade to "warn" and
// the deploy path re-verifies everything authoritatively anyway.

import type { ActiveAccount } from "./account.ts";
import { calculateCid, checkBulletinAuthorization } from "./store.ts";
import { MIN_PGAS, PGAS_ASSET_ID } from "../utils/balances.ts";
import { pgasShortfallWarn } from "./pgasShortfall.ts";
import { MAX_TX_BYTES } from "./limits.ts";
import { getEvmAddress } from "./dotns/address.ts";
import { checkDomainAvailability, getDomainOwner, quoteDomain } from "./dotns/register.ts";
import { getAssetHubClient } from "./chain.ts";
import {
    BULLETIN_FAUCET_URL,
    BULLETIN_GATEWAY,
    DOT_HOST,
    NATIVE_TO_ETH_RATIO,
    PAS_FAUCET_URL,
} from "./config.ts";

export type CheckState = "ok" | "warn" | "fail";

export interface PreflightCheck {
    id: "size" | "bulletin" | "name" | "funds";
    label: string;
    state: CheckState;
    detail: string | null;
    /** Technical detail (bytes, balances, tiers) shown only when the user
     *  toggles "Details" — the dev-facing version of `detail`. */
    tech: string | null;
    /** Actionable link (faucet etc.) rendered next to the detail. */
    link: string | null;
}

export interface PreflightReport {
    checks: PreflightCheck[];
    /** True when nothing is "fail" — warns don't block the Deploy button. */
    ok: boolean;
    bytes: number;
    cid: string;
    label: string;
    url: string;
    gatewayUrl: string;
    /** Registration price in native units, when the quote succeeded. */
    priceNative: bigint | null;
}

// PAS has 10 decimals on Asset Hub (same as contracts.ts's logAccountInfo).
// This was 1e12 for a while, which made every amount on the deploy screen
// read 100× too small and the fee margin demand ~500 PAS of headroom.
const PAS = 10_000_000_000n;
// Rough headroom for fees + the two contract storage deposits. Deliberately
// coarse — exact estimation needs per-tx query_info and isn't worth it.
const FEE_MARGIN = 5n * PAS;

export function formatPas(native: bigint): string {
    const whole = native / PAS;
    const frac = ((native % PAS) * 10_000n) / PAS;
    return frac === 0n
        ? `${whole} PAS`
        : `${whole}.${frac.toString().padStart(4, "0").replace(/0+$/, "")} PAS`;
}

/** Append `address=<acct>` to a faucet URL, preserving any existing query
 *  (the PAS faucet already carries `?parachain=<id>`), so "Open faucet"
 *  lands on a form pre-filled for the account that needs funding. */
export function withAddress(url: string, address: string): string {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}address=${encodeURIComponent(address)}`;
}

/** Client-side label rules — same shape the chain-side PoP rules expect. */
export function validateLabel(label: string): string | null {
    if (!label) return "Name is empty";
    if (!/^[a-z0-9-]+$/.test(label))
        return "Use lowercase letters, digits, and hyphens only";
    if (label.startsWith("-") || label.endsWith("-"))
        return "Can't start or end with a hyphen";
    if (label.length < 3) return "Must be at least 3 characters";
    if (label.length > 63) return "Must be at most 63 characters";
    return null;
}

const verifyLater = (id: PreflightCheck["id"], label: string): PreflightCheck => ({
    id,
    label,
    state: "warn",
    detail: "Couldn't check. The deploy will verify this.",
    tech: "Check timed out or the RPC errored (read-only — deploy re-verifies).",
    link: null,
});

// Each chain check catches its own errors, but a hung RPC connection never
// rejects — it just stays pending, pinning the UI on "checking…" forever.
// Racing against a deadline makes the report total: worst case is a row of
// "couldn't verify" warns, and the checklist is advisory anyway (deploy
// re-verifies everything on-chain).
const CHECK_TIMEOUT_MS = 5_000;

const guarded = (
    id: PreflightCheck["id"],
    label: string,
    check: () => Promise<PreflightCheck>,
): Promise<PreflightCheck> =>
    Promise.race([
        check().catch(() => verifyLater(id, label)),
        new Promise<PreflightCheck>((resolve) =>
            setTimeout(() => resolve(verifyLater(id, label)), CHECK_TIMEOUT_MS),
        ),
    ]);

export async function runPreflight(params: {
    html: string;
    label: string;
    account: ActiveAccount;
}): Promise<PreflightReport> {
    const { html, label, account } = params;

    const bytes = new TextEncoder().encode(html);
    const cid = (await calculateCid(bytes)).toString();

    // ── size: local, exact ───────────────────────────────────────────────
    const sizeCheck: PreflightCheck = {
        id: "size",
        label: "App size",
        state: bytes.length <= MAX_TX_BYTES ? "ok" : "fail",
        detail:
            bytes.length <= MAX_TX_BYTES
                ? "Ready"
                : "Too large to deploy. Remove large files or images",
        tech: `${bytes.length.toLocaleString()} B / ${(MAX_TX_BYTES / 1024 / 1024).toFixed(0)} MiB max`,
        link: null,
    };

    // ── bulletin: one store path now (CloudStorageClient). A HOST account's
    //    allowance is provisioned automatically during deploy (ensureSignerReady
    //    grants BulletinAllowance), so storage is never a user concern for it —
    //    always shown ready. Dev accounts must self-serve at the faucet. ─
    const bulletinCheck = async (): Promise<PreflightCheck> => {
        if (account.source === "host") {
            return {
                id: "bulletin",
                label: "Storage",
                state: "ok",
                detail: "Ready",
                tech: "Host account — BulletinAllowance provisioned during deploy",
                link: null,
            };
        }
        const auth = await checkBulletinAuthorization(account.address);
        if (!auth.authorized) {
            return {
                id: "bulletin",
                label: "Storage",
                state: "fail",
                detail: "You need storage access to deploy.",
                tech: `${account.displayName} has no Bulletin storage authorization`,
                link: BULLETIN_FAUCET_URL,
            };
        }
        if (auth.remainingBytes < BigInt(bytes.length)) {
            return {
                id: "bulletin",
                label: "Storage",
                state: "warn",
                detail: "Storage may be low for this app.",
                tech: `${auth.remainingBytes.toLocaleString()} B allowance left for a ${bytes.length.toLocaleString()} B app`,
                link: BULLETIN_FAUCET_URL,
            };
        }
        return {
            id: "bulletin",
            label: "Storage",
            state: "ok",
            detail: "Ready",
            tech: `${auth.remainingBytes.toLocaleString()} B allowance remaining`,
            link: null,
        };
    };

    // ── name: local validity → availability → PoP quote ─────────────────
    let priceNative: bigint | null = null;
    const nameCheck = async (): Promise<PreflightCheck> => {
        const invalid = validateLabel(label);
        if (invalid) {
            return { id: "name", label: ".dot name", state: "fail", detail: invalid, tech: `validateLabel: ${invalid}`, link: null };
        }
        const ownerEvm = await getEvmAddress(account.address);
        const available = await checkDomainAvailability(label, account.address);
        if (!available) {
            const owner = await getDomainOwner(label, account.address);
            if (owner && owner.toLowerCase() === ownerEvm.toLowerCase()) {
                return {
                    id: "name",
                    label: ".dot name",
                    state: "ok",
                    detail: "Yours, deploy updates it",
                    tech: `${label}.dot owned by this account — deploy does setContenthash only`,
                    link: null,
                };
            }
            return {
                id: "name",
                label: ".dot name",
                state: "fail",
                detail: "Taken, pick another name",
                tech: `${label}.dot already registered to ${owner ?? "another account"}`,
                link: null,
            };
        }
        const quote = await quoteDomain(label, ownerEvm, account.address);
        if (quote.price !== null) priceNative = quote.price / NATIVE_TO_ETH_RATIO;
        const priceText = priceNative !== null ? ` · price ${formatPas(priceNative)}` : "";
        // The message is a classification, present even on success
        // ("Available to all"). The actual verdict is the tier comparison:
        // the account can register iff userStatus >= status. A shortfall is a
        // hard fail, not a warning — registration WILL be rejected, so letting
        // the deploy proceed only burns a commitment (see the matching guard
        // in deploy.ts before commitDomain).
        if (
            quote.status !== null &&
            quote.userStatus !== null &&
            quote.userStatus < quote.status
        ) {
            // Account-aware gate: the name's required PoP tier (`status`)
            // exceeds this account's verification tier (`userStatus`), so
            // registration WOULD revert — block rather than waste the
            // transaction. This is NOT a blanket "needs two trailing digits"
            // rule; a verified account clears higher-tier names. Surface the
            // contract's own classification message when it gives one.
            return {
                id: "name",
                label: ".dot name",
                state: "fail",
                // Reason (from the contract) + the universally-registrable
                // shape so the advice is concrete. Any account can register a
                // name of ≥9 letters ending in two digits, whatever its tier.
                detail: `${quote.message ? `${quote.message}. ` : ""}Try a longer name (9+ letters) ending in two digits.`,
                tech: `requires name tier ${quote.status}, your PoP tier ${quote.userStatus}${quote.message ? ` ("${quote.message}")` : ""}${priceText}`,
                link: null,
            };
        }
        return {
            id: "name",
            label: ".dot name",
            state: "ok",
            detail: "Available",
            tech: `available${priceText}${quote.status !== null ? `, name tier ${quote.status}` : ""}${quote.userStatus !== null ? `, your PoP tier ${quote.userStatus}` : ""}`,
            link: null,
        };
    };

    // ── funds: host allowance, or on-chain balance for extension/dev ────
    let freeNative: bigint | null = null;
    let pgasBalance: bigint | null = null;
    const fundsCheck = async (): Promise<PreflightCheck> => {
        // Host-mediated transactions are FEE-sponsored (AsPgas), but the
        // domain price and pallet-revive storage deposits are value
        // transfers from the account's own balance — empirically the host
        // does NOT cover those (register dispatches Revive::TransferFailed
        // on an unfunded product account). So every source needs a balance;
        // only the wording differs.
        const { api } = await getAssetHubClient();
        // BEST block, not PAPI's finalized default — an account funded
        // seconds ago should pass preflight without waiting out finality.
        const info = await api.query.System.Account.getValue(account.address, {
            at: "best",
        });
        const free: bigint = info.data.free;
        freeNative = free;
        if (account.source === "host") {
            const pgasAcct = await api.query.Assets.Account.getValue(
                PGAS_ASSET_ID,
                account.address,
                { at: "best" },
            );
            pgasBalance = pgasAcct?.balance ?? 0n;
        }
        if (free === 0n) {
            return {
                id: "funds",
                label: "Balance",
                state: "fail",
                detail: "Test tokens are needed to register your .dot name.",
                tech: `0 PAS free on Asset Hub${account.source === "host" ? " (fees host-sponsored, but the domain price + deposits aren't)" : ""}`,
                link: withAddress(PAS_FAUCET_URL, account.address),
            };
        }
        return {
            id: "funds",
            label: "Balance",
            state: "ok",
            detail: "Ready",
            tech: `${formatPas(free)} free on Asset Hub${account.source === "host" ? " (fees host-sponsored)" : ""}`,
            link: null,
        };
    };

    // Note: account mapping isn't surfaced as a checklist row — it's never
    // user-actionable (already mapped, or the deploy runs map_account itself),
    // so it would only add noise. The deploy path verifies/maps independently.

    const [bulletin, name, funds] = await Promise.all([
        guarded("bulletin", "Storage", bulletinCheck),
        guarded("name", ".dot name", nameCheck),
        guarded("funds", "Balance", fundsCheck),
    ]);

    // Cross-check once both sides are known: balance vs price + headroom
    // (deposits dominate the margin; host fee sponsorship doesn't change it
    // much since fees are the smallest component).
    if (
        funds.state === "ok" &&
        priceNative !== null &&
        freeNative !== null &&
        freeNative < priceNative + FEE_MARGIN
    ) {
        // Two sub-cases hide in this band. Below the domain price we KNOW it's
        // short → definitive fail. Above the price but within the coarse fee/
        // deposit margin we genuinely can't be sure (no exact per-tx estimate),
        // so that one stays a hedge.
        const belowPrice = freeNative < priceNative;
        funds.state = belowPrice ? "fail" : "warn";
        funds.detail = belowPrice
            ? "Not enough to register your .dot name."
            : "You're close. Top up to cover the registration fees.";
        funds.tech = `${formatPas(freeNative)} free vs price ${formatPas(priceNative)} + ~${formatPas(FEE_MARGIN)} fees/deposits`;
        funds.link = withAddress(PAS_FAUCET_URL, account.address);
    }

    // Host accounts: contract-call fees are PGAS-sponsored. A low-but-nonzero
    // PGAS budget won't be topped up by the deploy's allowance request (it only
    // fires at balance 0). Surface it as an under-funded funds row (keeping the
    // PGAS figure in `tech`) so the host-routing below sends the user to Collect
    // resources. Only touches an otherwise-ok row — never masks a price fail/warn.
    if (
        funds.state === "ok" &&
        pgasBalance !== null &&
        pgasShortfallWarn(account.source, pgasBalance)
    ) {
        const pgasLocal: bigint = pgasBalance;
        funds.state = "warn";
        funds.detail = "Low on resources. Collect more before deploying.";
        funds.tech = `${pgasLocal.toLocaleString()} PGAS (< ${MIN_PGAS.toLocaleString()} floor) — host contract fees are PGAS-sponsored`;
        funds.link = null;
    }

    // Host accounts fund native PAS through the in-app "Collect resources" flow
    // (the PGAS claim + the contract faucet), not an external faucet. So any
    // under-funded host result — a native shortfall OR the low-PGAS warn above —
    // becomes a hard fail with no external link, and the Deploy action routes the
    // user to Collect resources instead. Dev accounts self-serve with their own
    // key, so they keep the external faucet link.
    if (account.source === "host" && funds.state !== "ok") {
        funds.state = "fail";
        funds.detail = "You need more resources to deploy.";
        funds.link = null;
    }

    const checks = [sizeCheck, bulletin, name, funds];
    return {
        checks,
        ok: checks.every((c) => c.state !== "fail"),
        bytes: bytes.length,
        cid,
        label,
        url: `https://${label}.${DOT_HOST}`,
        gatewayUrl: `${BULLETIN_GATEWAY}${cid}`,
        priceNative,
    };
}
