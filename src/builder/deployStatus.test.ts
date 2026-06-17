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
import { stepForDeployStatus, stepForUploadStatus } from "./deployStatus.ts";

// DEPLOY_STEPS: 0 prepare · 1 bulletin · 2 account · 3 name · 4 commit ·
//               5 wait · 6 register · 7 link
//
// These tests pin the coupling between the granular status text the chain
// helpers emit (after deploy.ts prefixes it with "DotNS register: " /
// "DotNS resolver: " / "Bulletin: ") and the progress step it must light up.
// If someone rewords a status line without updating stepForDeployStatus — the
// exact regression this guards — a case here fails instead of the bar silently
// jumping to the wrong step in production.

describe("stepForDeployStatus — commit phase (step 4)", () => {
    // commitDomain wraps these as "DotNS register: <text>".
    const commit = (s: string) => `DotNS register: ${s}`;
    it.each([
        "Setting up your account…",
        "Reserving your domain name…",
        "Preparing to reserve your domain name…",
        "Awaiting signature — reserving your domain name…",
        "Domain name reserved",
    ])("routes %j to Commit", (text) => {
        expect(stepForDeployStatus(commit(text))).toBe(4);
    });

    it("does NOT mistake 'Awaiting signature' for the 'Waiting' age step", () => {
        // The signing line deliberately says "Awaiting", not "Waiting" — the
        // latter prefix routes to the commitment-age Wait step (5).
        expect(stepForDeployStatus(commit("Awaiting signature — reserving your domain name…"))).not.toBe(5);
        expect(stepForDeployStatus(commit("Waiting 6s for your domain name…"))).toBe(5);
    });
});

describe("stepForDeployStatus — register phase (step 6)", () => {
    const reg = (s: string) => `DotNS register: ${s}`;
    it.each([
        "Pricing your domain name…",
        "Awaiting signature, registering your domain name…",
        "Registering your domain name…",
        "Domain name registered",
    ])("routes %j to Register", (text) => {
        expect(stepForDeployStatus(reg(text))).toBe(6);
    });

    it("keeps the register signing/broadcasting ahead of the commit step", () => {
        // Regression: before the rework the register broadcast line had no
        // explicit case and fell through to the commit step (4), dragging the
        // bar backward mid-register.
        expect(stepForDeployStatus(reg("Awaiting signature, registering your domain name…"))).toBeGreaterThan(4);
        expect(stepForDeployStatus(reg("Registering your domain name…"))).toBeGreaterThan(4);
    });
});

describe("stepForDeployStatus — resolver, bulletin, read phases", () => {
    it("routes content-hash (resolver) lines to Link (step 7)", () => {
        for (const s of [
            "Awaiting signature — content hash…",
            "Broadcasting content hash…",
            "Content hash set",
        ]) {
            expect(stepForDeployStatus(`DotNS resolver: ${s}`)).toBe(7);
        }
    });

    it("routes every prettified Bulletin line to Store (step 1)", () => {
        for (const s of [
            "Bulletin: connecting…",
            "Bulletin: awaiting signature…",
            "Bulletin: awaiting signature — chunk 1/3…",
            "Bulletin: broadcasting…",
            "Bulletin: confirming…",
            "Bulletin: stored",
        ]) {
            expect(stepForDeployStatus(s)).toBe(1);
        }
    });

    it("routes the read-only owner/availability dry-runs to Account/Name", () => {
        expect(stepForDeployStatus("DotNS: resolving owner account…")).toBe(2);
        expect(stepForDeployStatus("DotNS: checking domain availability…")).toBe(3);
    });

    it("sends owned-name updates straight to Register, skipping commit/wait", () => {
        expect(stepForDeployStatus("DotNS: domain name already yours — updating content…")).toBe(6);
    });
});

describe("stepForUploadStatus", () => {
    // The image-upload bar matches the RAW DeployStatus tokens store.ts emits —
    // these must stay literal even though the deploy line reworps them.
    it.each([
        ["signing", 1],
        ["broadcasting", 2],
        ["in-block", 3],
        ["finalized", 4],
        ["something else", 0],
    ])("routes %j to step %i", (text, step) => {
        expect(stepForUploadStatus(text as string)).toBe(step);
    });
});
