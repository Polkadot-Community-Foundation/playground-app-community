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
import { deployButtonState, type DeployButtonArgs } from "./deployButton.ts";

/**
 * Base args: a connected account with a valid, in-limit name, no active
 * operation, and no network check run yet. The button reads "Deploy" but
 * leads with the check — clicking it runs the bounded pre-flight, which
 * auto-deploys on a clean pass.
 */
const base: DeployButtonArgs = {
    busy: false,
    preflightBusy: false,
    hasAccount: true,
    hasName: true,
    localOk: true,
    checkFresh: false,
    preflightOk: null,
    preflightFailed: false,
};

describe("deployButtonState", () => {
    // ── Default: "Deploy" that leads with the check ─────────────────────────
    it("offers Deploy (check-led, enabled) with no network check run", () => {
        const s = deployButtonState(base);
        expect(s.mode).toBe("check");
        expect(s.label).toBe("Deploy");
        expect(s.disabled).toBe(false);
    });

    // ── Local hard-blocks (network-free, deterministic) disable the button ──
    it("disables the button when the local checks fail (oversized / bad name)", () => {
        const s = deployButtonState({ ...base, localOk: false });
        expect(s.mode).toBe("check");
        expect(s.disabled).toBe(true);
    });

    it("disables the button when no account is connected", () => {
        const s = deployButtonState({ ...base, hasAccount: false });
        expect(s.mode).toBe("check");
        expect(s.disabled).toBe(true);
    });

    it("disables the button when the name is empty", () => {
        const s = deployButtonState({ ...base, hasName: false });
        expect(s.mode).toBe("check");
        expect(s.disabled).toBe(true);
    });

    it("disables the button when account and name are both missing", () => {
        const s = deployButtonState({ ...base, hasAccount: false, hasName: false });
        expect(s.mode).toBe("check");
        expect(s.disabled).toBe(true);
    });

    // ── In-flight states ───────────────────────────────────────────────────
    it("shows Checking… (disabled) while the network check runs", () => {
        const s = deployButtonState({ ...base, preflightBusy: true });
        expect(s.mode).toBe("checking");
        expect(s.label).toBe("Checking…");
        expect(s.disabled).toBe(true);
    });

    it("deploying takes highest precedence over everything else", () => {
        const s = deployButtonState({
            ...base,
            busy: true,
            preflightBusy: true,
            checkFresh: true,
            preflightOk: true,
        });
        expect(s.mode).toBe("deploying");
        expect(s.disabled).toBe(true);
    });

    it("checking takes precedence over a fresh result", () => {
        const s = deployButtonState({
            ...base,
            preflightBusy: true,
            checkFresh: true,
            preflightOk: false,
        });
        expect(s.mode).toBe("checking");
        expect(s.disabled).toBe(true);
    });

    // ── A fresh pass rests on a direct-retry "Deploy" ───────────────────────
    // The happy path auto-deploys straight from the check; this resting state
    // is only reached when that auto-deploy didn't stick (e.g. it errored).
    it("rests on a direct-retry Deploy after a fresh passing check", () => {
        const s = deployButtonState({ ...base, checkFresh: true, preflightOk: true });
        expect(s.mode).toBe("deploy");
        expect(s.label).toBe("Deploy");
        expect(s.disabled).toBe(false);
    });

    // ── A fresh non-pass splits into "Check again" + secondary deploy ───────
    it("shows Check again (enabled) after a fresh FAILING check", () => {
        const s = deployButtonState({ ...base, checkFresh: true, preflightOk: false });
        expect(s.mode).toBe("checkAgain");
        expect(s.label).toBe("Check again");
        expect(s.disabled).toBe(false);
    });

    it("shows Check again (enabled) after a fresh ERRORED check", () => {
        const s = deployButtonState({
            ...base,
            checkFresh: true,
            preflightOk: null,
            preflightFailed: true,
        });
        expect(s.mode).toBe("checkAgain");
        expect(s.disabled).toBe(false);
    });

    it("a local hard-block still disables Check again after a fresh failing check", () => {
        // The non-passing result relabels to "Check again", but a local
        // hard-fail (oversized / bad name) is a certain failure → stays disabled.
        const s = deployButtonState({
            ...base,
            localOk: false,
            checkFresh: true,
            preflightOk: false,
        });
        expect(s.mode).toBe("checkAgain");
        expect(s.disabled).toBe(true);
    });

    // ── Staleness: a name edit drops back to the check-led "Deploy" ─────────
    it("a stale result (checkFresh=false) reverts to the check-led Deploy", () => {
        // Check failed, then the user edited the name → checkFresh false. The
        // stale failure must not keep the "Check again" split; the button
        // leads with a fresh check again.
        const s = deployButtonState({
            ...base,
            checkFresh: false,
            preflightOk: false,
            preflightFailed: true,
        });
        expect(s.mode).toBe("check");
        expect(s.label).toBe("Deploy");
        expect(s.disabled).toBe(false);
    });
});
