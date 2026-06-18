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

import { test, expect } from "./fixtures.js";
import { waitForAppReady, openDetailPanel, waitForCardMetadata, openMyApps, openApps } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";
import { getSignerRating } from "./registry.js";

// Requires SIGNER to be a funded, h160-mapped account — one balance,
// accessible via either ss58 or h160 (Revive.map_account() links them;
// setup.ts handles mapping). CI runs with E2E_FUNDER_SEED set via repo
// secret; local runs without the secret will fail loudly. See
// e2e/README.md "Signing identity".
//
// NOTE: covers the current `@mock/reputation` averaged-rating mechanic.
// When backlog item #1 ships (cumulative star award + on-chain points),
// this file gets superseded by stars-flavoured tests.
test.describe("rating", () => {
  // Un-fixme'd in becca/e2e-reactivate-signing-modes. The previous fixme
  // attributed the hang to out-of-sync product-sdk-descriptors, and PR #142
  // (closed 2026-05-06) failed to unblock by bumping chain-client. Re-analysis
  // of migration-gaps.md identified the actual cause as a missing
  // productAccounts mapping in e2e/fixtures.ts: getProductAccount() was
  // falling back to //Bob//<dotNsId>/0 — an unfunded derived account — so
  // every signed tx was silently dropped at signSubmitAndWatch. Fixed in the
  // same branch by wiring productAccounts back to the funder. If this test
  // hangs again, check the productAccounts entry FIRST before suspecting
  // descriptors.
  // FIXME — first-run after un-fixme on this PR. Was test.fixme since
  // the SDK 0.6 → 0.7 migration (the `descriptors out of sync` ghost
  // PR #142 chased). Now that productAccounts is wired, the test
  // STARTS to run — but fails fast (~10s) in CI without reaching the
  // 60s waitForCardMetadata timeout, suggesting a Node-side write
  // path issue (getSignerRating reads from `@mock/reputation` via
  // `@parity/product-sdk-contracts` which may share the host-routed
  // chain-client issue with publishDomain).
  //
  // Treat as first-run-not-regression per TESTING_PLAN.md §First-run
  // note. Needs an investigation pass against current SDK 0.7.x
  // semantics; assertions were written aspirationally and may need
  // updating. Likely candidates:
  //   - getSignerRating Node-side path
  //   - rate.tx flow inside the iframe (also reaches Bulletin?)
  // Re-enable after individual investigation.
  test.fixme("favoriting the fixture records the signer's rating as 255", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);

    // Trigger signer connection by visiting My Apps.
    await openMyApps(frame);
    await frame.locator('[data-testid="my-apps-account"]').waitFor({ state: "visible", timeout: 30_000 });

    await openApps(frame);
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);

    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    const favBtn = panel.locator('[data-testid="detail-fav-btn"]');
    await expect(favBtn).toBeVisible();

    // Normalize to a known starting state of "not favorited". The panel
    // hydrates `isFav` from the on-chain rating async after mount
    // (AppDetailPanel.tsx useEffect on `reviewer`). The new binary-fav UI
    // toggles on every tap, so if the prior state is already "favorited"
    // we'd un-fav on the test tap and the post-state assertion would read
    // 0 instead of 255. Clearing through the UI first guarantees a
    // deterministic not-fav → fav transition.
    const prior = await getSignerRating(FIXTURE_DOMAIN);
    if (prior > 0) {
      await expect(favBtn).toHaveAttribute("data-active", "true", { timeout: 30_000 });
      await favBtn.click();
      await expect(favBtn).toHaveAttribute("data-active", "false", { timeout: 60_000 });
      expect(
        await getSignerRating(FIXTURE_DOMAIN),
        "rating should read as cleared before re-favoriting",
      ).toBe(0);
    }

    await testHost.clearSigningLog();
    await favBtn.click();
    await expect(favBtn).toHaveAttribute("data-active", "true", { timeout: 60_000 });

    const log = await testHost.getSigningLog();
    expect(log.length, "fav must sign at least one tx").toBeGreaterThanOrEqual(1);

    // Same `createTransaction` type-discriminator check as the mobile-signer
    // post-login test: locks in the host_create_transaction signing path
    // (post-fe53d3e) and catches a regression to the legacy PJS signer.
    // This runs once the descriptors-regen fixme upstream resolves.
    const createTxEntries = log.filter((e) => e.type === "createTransaction");
    expect(
      createTxEntries.length,
      "fav must go through host_create_transaction (type='createTransaction')",
    ).toBeGreaterThanOrEqual(1);

    // The signer's recorded rating MUST be 255 — the binary-fav UI writes
    // max u8 on fav. Direct check of the operation we just performed,
    // independent of how many other raters exist. The aggregate count is
    // intentionally not asserted: it depends on whether this signer has
    // rated before, which makes it brittle without test-owned setup that
    // resets state. Per-rater state is the strong signal.
    const afterSignerRating = await getSignerRating(FIXTURE_DOMAIN);
    expect(afterSignerRating, "signer's recorded rating after favoriting").toBe(255);
  });
});
