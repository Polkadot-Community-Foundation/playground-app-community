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
 * Mobile-signer flow — RFC-0009 login + post-login signing.
 *
 * The playground app's production sign-in is the Polkadot mobile-app PoP
 * flow: tap sign-in → QR rendered → mobile app scans → PoP attestation →
 * host now has a session key → product can sign without further phone
 * approvals. The QR + on-phone cryptography is impossible to drive from
 * Playwright (no phone in the loop). The host-api-test-sdk mocks the
 * OUTCOME via setLoginBehavior('success' | 'reject'); everything from the
 * login-result delivery onward IS exercised here.
 *
 * Existing specs (browse, detail, my-apps, rate, etc.) are "dev signer"
 * mode — accounts pre-injected into the host fixture, login flow bypassed.
 * That covers the developer-laptop path. This file covers the mobile path
 * end-to-end (minus the phone bit).
 *
 * Each test resets host-side auth state in beforeEach so login can be
 * re-driven. The fixture provides accounts + productAccounts mapping (see
 * e2e/fixtures.ts) so once login completes, signing routes back to the
 * funder. Without productAccounts wired the host would derive
 * //Bob//<dotNsId>/0 as a fallback and tx submission would silently hang
 * — see e2e/README.md "productAccounts wiring".
 */

import { mobileSignerTest as test, expect, FIXTURE_METADATA_BYTES } from "./fixtures.js";
import { waitForAppReady, openMyApps, openDetailPanel, waitForCardMetadata } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";

// Uses `mobileSignerTest` (mobile-signer named fixture). Currently
// structurally identical to `test` (signerFixture) — see fixtures.ts
// for why the "zero-state" version isn't viable with the current SDK.
// Named separately so the intent is legible AND so future SDK changes
// can swap behaviour here without touching this file.
//
// The cold-start init path IS exercised: every test does
// `testHost.page.reload()` which triggers a full iframe re-init →
// signerManager.connect() → first login request. That's the actual
// "cold start." simulateDisconnect() in beforeEach below resets the
// host's auth state between tests so each test drives the login
// rather than getting an "alreadyConnected" response.

test.describe("Mobile signer — login + signing flow", () => {
  // The test host's `Ba` (isAuthenticated) state persists across the page
  // since it lives in the parent window, not the iframe. Reset to a clean
  // unauthenticated state at the start of each test so setLoginBehavior
  // actually gates the next login request rather than getting short-
  // circuited by an "alreadyConnected" response from a prior test.
  test.beforeEach(async ({ testHost }) => {
    await testHost.simulateDisconnect();
    await testHost.clearSigningLog();
    await testHost.clearPermissionLog();
    await testHost.setPermissionBehavior("approve-all");
  });

  test("login success → product reaches connected state, signer hydrates", async ({ testHost }) => {
    await testHost.setLoginBehavior("success");
    await testHost.page.reload();

    const frame = await waitForAppReady(testHost);
    await openMyApps(frame);

    // The connect-prompt may flash briefly during signerManager.connect();
    // the post-login state is what we assert on.
    await expect(frame.locator('[data-testid="my-apps-account"]'))
      .toBeVisible({ timeout: 30_000 });

    expect(
      await testHost.getIsAuthenticated(),
      "host must record the user as authenticated after login=success",
    ).toBe(true);
  });

  // login reject test moved to mobile-signer-login-reject.spec.ts —
  // needs a different fixture (accounts: []) so the login flow actually
  // fires. See that file for the test body.

  test("post-login signing — rating the fixture surfaces in the signing log", async ({ testHost }) => {
    await testHost.setLoginBehavior("success");
    await testHost.page.reload();
    // Re-seed the fixture's metadata preimage AFTER the reload —
    // empirically the host's preimage store doesn't persist across
    // page reloads, so the beforeEach seed (in fixtures.ts) is gone
    // by now. Without this, waitForCardMetadata below would time out
    // at 60s waiting for the iframe's BulletinClient subscription to
    // resolve. See the FIXTURE_METADATA_BYTES export in fixtures.ts.
    await testHost.seedPreimage(FIXTURE_METADATA_BYTES);

    const frame = await waitForAppReady(testHost);

    // Trigger signer hydration (My Apps mount calls into signer.selectedAccount).
    await openMyApps(frame);
    await frame.locator('[data-testid="my-apps-account"]')
      .waitFor({ state: "visible", timeout: 30_000 });

    // Use My Apps for the fixture. On the migrated registry the public recents
    // grid is paginated by newest-first order, so this older fixture is no
    // longer guaranteed to be in the initially loaded recents page.
    await waitForCardMetadata(frame, FIXTURE_DOMAIN, { grid: "my-apps" });

    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN, { grid: "my-apps" });

    // The SIGNER (E2E Funder) owns the fixture, so the new star UI renders
    // a self-star notice instead of a toggle button — the star path can't
    // be exercised against an owner-held domain. Use the owner-only
    // visibility toggle as the signed action instead: same host_create_-
    // transaction path, same log shape, but rendered for the owner.
    await expect(panel.locator('[data-testid="visibility-private-btn"]'))
      .toBeVisible({ timeout: 30_000 });

    // Clear right before the signed action so the log assertion below
    // measures ONLY the visibility submission, not earlier setup signs.
    await testHost.clearSigningLog();

    // runVisibilityToggle always fires the tx regardless of current state
    // (no early-return when new == current), so the direction doesn't
    // matter for the assertion. Setup leaves the fixture PUBLIC; clicking
    // Private flips it. Teardown sets PRIVATE anyway, so this is a no-op
    // at the suite boundary.
    await panel.locator('[data-testid="visibility-private-btn"]').click();

    // Poll the host's signing log directly — the deterministic signal
    // that the tx round-tripped through host_create_transaction.
    await expect.poll(
      async () => (await testHost.getSigningLog()).length,
      {
        timeout: 60_000,
        message: "host must receive at least one sign request from the visibility tap",
      },
    ).toBeGreaterThanOrEqual(1);

    const log = await testHost.getSigningLog();
    expect(
      log.length,
      "host must have received at least one sign request from the post-login session",
    ).toBeGreaterThanOrEqual(1);

    // Lock in the post-fe53d3e signing path: product-account signing
    // routes through `host_create_transaction` rather than the legacy
    // PJS-style signed-payload submission. Host-api-test-sdk 0.8.2 widens
    // SigningLogEntry.type to include 'createTransaction' specifically
    // for this. Regression catcher for any future signer implementation
    // that bypasses host_create_transaction (which would fail under the
    // AsPgas signed-extension and trigger the same class of failure that
    // 0.7.9-4's signer fix resolved).
    const createTxEntries = log.filter((e) => e.type === "createTransaction");
    expect(
      createTxEntries.length,
      "at least one entry must have type='createTransaction' (host_create_transaction path)",
    ).toBeGreaterThanOrEqual(1);
  });

  // FIXME — getPermissionLog() comes back empty even after explicitly
  // revoking all granted permissions + setPermissionBehavior("reject-all")
  // + clicking submit (verified by getting past the metadata-load and the
  // submit-click steps). Suggests the product's signer.signSubmitAndWatch
  // for rate_app doesn't actually go through the ChainSubmit permission
  // flow under the current SDK — or the SDK's permission enforcement
  // path differs from what this test was written against.
  //
  // Iframe-side state IS verified (data-status never reaches "done",
  // signing log is empty) — the missing piece is the host-side permission
  // log assertion. Treat as first-run per the plan; needs a confirm with
  // host-api-test-sdk team on what triggers permission requests for
  // contract signing in 0.7.x.
  test.fixme("permission reject mid-session — sign attempt surfaces an error, no orphan signing-log entry", async ({ testHost }) => {
    await testHost.setLoginBehavior("success");
    await testHost.page.reload();
    // Re-seed preimage post-reload — same reason as post-login signing.
    await testHost.seedPreimage(FIXTURE_METADATA_BYTES);

    const frame = await waitForAppReady(testHost);
    await openMyApps(frame);
    await frame.locator('[data-testid="my-apps-account"]')
      .waitFor({ state: "visible", timeout: 30_000 });

    // After login but BEFORE the user signs anything: revoke any
    // auto-granted permissions (the login flow may have pre-granted
    // ChainSubmit when allowances were configured during the
    // permissionLog of the fixture's connect step). Then flip behavior
    // to reject-all so the next request — issued by the rating submit
    // below — actually goes through the request → reject path.
    // Without the revoke, "reject-all" never fires because the
    // permission is already granted from earlier in the session.
    await testHost.clearPermissionLog();
    for (const tag of await testHost.getGrantedPermissions()) {
      await testHost.revokePermission(tag);
    }
    await testHost.setPermissionBehavior("reject-all");
    await testHost.clearSigningLog();

    // Use My Apps for the fixture. On the migrated registry the public recents
    // grid is paginated by newest-first order, so this older fixture is no
    // longer guaranteed to be in the initially loaded recents page.
    await waitForCardMetadata(frame, FIXTURE_DOMAIN, { grid: "my-apps" });
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN, { grid: "my-apps" });
    await expect(panel.locator('[data-testid="detail-fav-btn"]')).toBeVisible();

    // Single-tap binary-fav submit. Under reject-all the rate tx should be
    // refused at the permission layer before reaching the chain.
    await panel.locator('[data-testid="detail-fav-btn"]').click();

    // Rejection signal: favStatus settles to "error" (or stays "idle" if
    // the rejection is treated as a sign-cancel). Either way it must NOT
    // reach the success state where `data-active` flips. Asserting the
    // post-tap data-active reflects "no toggle happened" is the strongest
    // signal that doesn't depend on the failure-rendering shape, which
    // can shift.
    await expect(panel.locator('[data-testid="detail-fav-btn"]'))
      .not.toHaveAttribute("data-status", "submitting", { timeout: 30_000 });

    const log = await testHost.getSigningLog();
    expect(
      log.length,
      "permission reject must short-circuit before the host signs anything",
    ).toBe(0);

    const permLog = await testHost.getPermissionLog();
    expect(
      permLog.some((e) => !e.approved),
      "permission log must contain at least one rejected entry",
    ).toBe(true);
  });

  test("disconnect mid-session — host-side auth state flips off", async ({ testHost }) => {
    await testHost.setLoginBehavior("success");
    await testHost.page.reload();

    const frame = await waitForAppReady(testHost);
    await openMyApps(frame);
    await expect(frame.locator('[data-testid="my-apps-account"]'))
      .toBeVisible({ timeout: 30_000 });
    expect(await testHost.getIsAuthenticated()).toBe(true);

    await testHost.simulateDisconnect();

    expect(
      await testHost.getIsAuthenticated(),
      "simulateDisconnect must flip host-side auth state off",
    ).toBe(false);

    // The product MAY not subscribe to host disconnect events live —
    // signerManager could keep its cached "connected" state until the
    // next host call returns NotConnected. We assert host-side state
    // only; if the product picks up the disconnect proactively in a
    // future SDK release, add a UI assertion here.
  });

  test("reconnect after disconnect — auth state restored, second login flow succeeds", async ({ testHost }) => {
    await testHost.setLoginBehavior("success");
    await testHost.page.reload();
    const frame = await waitForAppReady(testHost);
    await openMyApps(frame);
    await expect(frame.locator('[data-testid="my-apps-account"]'))
      .toBeVisible({ timeout: 30_000 });

    // Disconnect → reconnect cycle.
    await testHost.simulateDisconnect();
    expect(await testHost.getIsAuthenticated()).toBe(false);

    await testHost.simulateReconnect();
    expect(
      await testHost.getIsAuthenticated(),
      "simulateReconnect must restore host-side auth state",
    ).toBe(true);

    // A fresh page reload should re-establish the connected UI without
    // requiring a new login (Ba=true → handleRequestLogin returns
    // "alreadyConnected").
    await testHost.page.reload();
    const frame2 = await waitForAppReady(testHost);
    await openMyApps(frame2);
    await expect(frame2.locator('[data-testid="my-apps-account"]'))
      .toBeVisible({ timeout: 30_000 });
  });
});
