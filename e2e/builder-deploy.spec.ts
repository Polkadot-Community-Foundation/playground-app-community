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
 * Site Builder (/builder) — end-to-end against the real Paseo Next stack,
 * signed by the builder's DEV ACCOUNT (createDevSigner, signs locally; no
 * host signer involved, so chain-client descriptor drift can't hang it).
 *
 * Two tiers:
 *
 *  1. Always-run: landing → editor → deploy panel → dev-account toggle →
 *     PREFLIGHT. The checklist is free (dry-runs only) but exercises the
 *     full read path for real: chain-client init, Revive account-mapping
 *     probe, DotNS owner/price reads, Bulletin authorization check.
 *
 *  2. `E2E_BUILDER_DEPLOY=1` opt-in: the PAID path — Bulletin store,
 *     DotNS commit → wait → register → setContenthash — through to the
 *     success panel. Registers a throwaway .dot domain and spends real
 *     PAS from the dev account each run, hence the gate.
 *
 * Preconditions for tier 2 (the preflight assertion reports which failed):
 *  - dev account funded with PAS on Paseo Asset Hub Next
 *  - dev account authorized on Bulletin Next
 *    (https://paritytech.github.io/polkadot-bulletin-chain/authorizations)
 */

import { test, expect } from "./fixtures.js";
import { waitForAppReady } from "./helpers.js";
import type { FrameLocator } from "@playwright/test";

async function openBuilderEditor(frame: FrameLocator) {
  await frame.locator('[data-testid="nav-builder"]').click();
  await frame.locator(".builder-card-button", { hasText: "Blank" }).click();
  await expect(frame.locator(".builder-root .site")).toBeVisible();
}

async function openDeployPanelWithDevAccount(frame: FrameLocator) {
  await frame.locator(".nav-tab", { hasText: "Deploy" }).click();
  const panel = frame.locator(".deploy-panel");
  await expect(panel).toBeVisible();
  await panel.locator(".checkbox input").check();
  // Dev account is synchronous — the slot must flip to the signer pill.
  await expect(panel.locator(".account-chip")).toContainText("Dev account");
  await expect(panel.locator(".account-address code")).toBeVisible();
  return panel;
}

test.describe("site builder — deploy pipeline", () => {
  test("deploy panel reaches a settled preflight verdict on the dev account", async ({
    testHost,
  }) => {
    const frame = await waitForAppReady(testHost);
    await openBuilderEditor(frame);
    const panel = await openDeployPanelWithDevAccount(frame);

    // The auto-derived .dot name seeds the checklist.
    await expect(panel.locator(".field input").first()).toHaveAttribute(
      "placeholder",
      /.+/,
    );

    // Preflight = real dry-runs against Paseo: mapping probe, DotNS owner,
    // price, Bulletin authorization. We assert it SETTLES (rows render and
    // the spinner state ends) — not that every check passes, since the dev
    // account's funding is an ops concern, not a code regression.
    const rows = panel.locator(".check-row");
    await expect(rows.first()).toBeVisible({ timeout: 90_000 });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(3);
    // Every row resolved to ok/warn/fail (state class lands on the row).
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toHaveClass(/check-(ok|warn|fail)/);
    }
  });

  // The PAID end-to-end: registers a throwaway domain, spends dev-account
  // PAS. Opt-in via E2E_BUILDER_DEPLOY=1.
  test("dev account deploys a site end-to-end to a live .dot domain", async ({
    testHost,
  }) => {
    test.skip(
      process.env.E2E_BUILDER_DEPLOY !== "1",
      "paid path — set E2E_BUILDER_DEPLOY=1 to run (registers a domain, spends PAS)",
    );
    test.setTimeout(360_000); // bulletin store + commit wait + 3 txs on Paseo

    const frame = await waitForAppReady(testHost);
    await openBuilderEditor(frame);

    // Unique page title → unique auto-derived .dot label (deriveDomain adds
    // random padding on top, so collisions need no handling here).
    const heading = frame.locator(".site h1.editable").first();
    await heading.click();
    await heading.press("ControlOrMeta+a");
    await heading.pressSequentially(`E2E ${Date.now().toString(36)}`);

    const panel = await openDeployPanelWithDevAccount(frame);

    // For the paid run the checklist must be CLEAN — a fail here means the
    // dev account precondition broke (funding / Bulletin authorization);
    // surface the row texts so the failure says which.
    const rows = panel.locator(".check-row");
    await expect(rows.first()).toBeVisible({ timeout: 90_000 });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      await expect
        .soft(row, await row.innerText())
        .not.toHaveClass(/check-fail/);
    }

    const deployBtn = panel.locator(".pill-primary");
    await expect(deployBtn).toBeEnabled();
    await deployBtn.click();

    // Warn-state checks (e.g. "Couldn't verify Bulletin authorization over
    // the host bridge") aren't clean, so the first click ARMS the
    // "Deploy anyway?" confirmation instead of deploying. Warns are
    // advisory by design — the deploy is the authority — so confirm.
    const confirm = panel.locator(".pill-confirm");
    if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirm.click();
    }

    // Full pipeline: Bulletin store → account → name → commit → wait (~12s
    // commitment age) → register → contenthash link. Success is THE panel.
    const success = panel.locator(".result-success");
    await expect(success).toBeVisible({ timeout: 300_000 });
    await expect(success.locator(".result-success-domain")).toContainText(".dot");
    const openLink = success.locator(".result-success-open");
    await expect(openLink).toHaveAttribute("href", /^https:\/\/.+\.dot\.li$/);
  });
});
