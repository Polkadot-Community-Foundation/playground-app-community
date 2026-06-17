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
 * Pure derivation of the primary deploy-button state.
 *
 * Flow model (check-first, one label):
 *
 * The primary button reads "Deploy" but leads with the bounded network check
 * (name availability / funds / storage). The happy path is one tap — "Deploy"
 * runs the check ("Checking…") and, on a clean pass, auto-proceeds into the
 * deploy ("Deploying…"); the chaining lives in the host, not here. The button
 * never rests in a passing state.
 *
 * When the fresh check did NOT pass we split the choice: the primary button
 * becomes "Check again" (re-run the bounded check, the usual fix for a flaky
 * network) and the host renders a secondary "Try to deploy anyway" beside it.
 * The chain is the real authority — `deploy.ts` independently re-verifies
 * availability, registrability, and funds *before* any paid write — so a
 * non-passing check informs rather than blocks.
 *
 * Deploy/check are gated ONLY on local, deterministic, network-free
 * conditions — a connected account, a non-empty name, and the local checks
 * (`localOk`: size within the tx limit + valid name format).
 *
 * Precedence (highest wins):
 *   deploying > checking > (not ready → disabled) > checkAgain > deploy > check
 *
 * `localOk` — local size + name-format checks pass (computed offline).
 * `checkFresh` — true only when the last completed network check ran for the
 *   current name (checkedLabel === effectiveLabel). A name edit invalidates it.
 * `preflightOk` — `preflight.ok` from the last completed run, or null when no
 *   fresh result is available (pre-check, errored, or stale).
 *
 * `deploy` mode (also labelled "Deploy") is reached only after a fresh pass
 * whose auto-deploy didn't stick (e.g. the deploy errored and `busy` cleared)
 * — a direct retry that skips a redundant re-check.
 */

export type DeployButtonMode =
    | "deploying"
    | "checking"
    | "check"
    | "checkAgain"
    | "deploy";

export interface DeployButtonState {
    mode: DeployButtonMode;
    label: string;
    disabled: boolean;
}

export interface DeployButtonArgs {
    /** A deploy transaction is in flight. */
    busy: boolean;
    /** A pre-flight (network) check is in flight. */
    preflightBusy: boolean;
    /** An account is connected. */
    hasAccount: boolean;
    /** The effective .dot label is non-empty. */
    hasName: boolean;
    /**
     * Local, network-free checks pass: app size within the tx limit AND the
     * name format is valid. These are deterministic and free to compute, so
     * they hard-block Deploy (the tx would certainly fail otherwise).
     */
    localOk: boolean;
    /**
     * True when the last completed network check ran for the current
     * effectiveLabel. False before any check, after a name edit, or after
     * account disconnect.
     */
    checkFresh: boolean;
    /**
     * `preflight.ok` from the last completed run, or null when no fresh
     * check result is available (pre-check, errored, or stale).
     */
    preflightOk: boolean | null;
    /** True when the last check attempt errored / could not complete. */
    preflightFailed: boolean;
}

const LABELS: Record<DeployButtonMode, string> = {
    deploying: "Deploying…",
    checking: "Checking…",
    check: "Deploy",
    checkAgain: "Check again",
    deploy: "Deploy",
};

export function deployButtonState(args: DeployButtonArgs): DeployButtonState {
    const { busy, preflightBusy, hasAccount, hasName, localOk, checkFresh, preflightOk, preflightFailed } =
        args;

    // 1. Deploy in flight — highest precedence.
    if (busy) {
        return { mode: "deploying", label: LABELS.deploying, disabled: true };
    }

    // 2. Network check in flight — disable to avoid a double-action; the check
    //    is bounded (15s) so this is a short, self-clearing state.
    if (preflightBusy) {
        return { mode: "checking", label: LABELS.checking, disabled: true };
    }

    // 3. Readiness gate — local + deterministic only. Missing account/name
    //    or a local hard-fail (oversized / bad name format) disables the
    //    button; the inline reason explains why. Network state never reaches
    //    here.
    const ready = hasAccount && hasName && localOk;

    // 4. A fresh network check that didn't pass → primary becomes "Check
    //    again" (re-run the bounded check); the host renders a secondary "Try
    //    to deploy anyway" beside it — advice, not a block, since the chain
    //    re-verifies.
    const failed = checkFresh && (preflightFailed || preflightOk === false);
    if (failed) {
        return { mode: "checkAgain", label: LABELS.checkAgain, disabled: !ready };
    }

    // 5. A fresh pass → "Deploy" (a direct retry). The happy path auto-deploys
    //    straight from the check and never rests here.
    if (checkFresh && preflightOk === true) {
        return { mode: "deploy", label: LABELS.deploy, disabled: !ready };
    }

    // 6. Default: no fresh check → "Check & deploy". Runs the bounded check,
    //    then auto-proceeds into deploy on a clean pass.
    return { mode: "check", label: LABELS.check, disabled: !ready };
}
