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
 * Mobile-signer login-REJECT test — split out from mobile-signer.spec.ts
 * because it needs a different test-host fixture (no accounts pre-
 * injected) than the other mobile-signer tests.
 *
 * Why: with accounts: [SIGNER] in the fixture, the test host returns
 * SIGNER from getLegacyAccounts during signer.connect(); the product
 * authenticates via legacy-account path and `isAuthenticated` flips to
 * true regardless of the setLoginBehavior outcome. The login flow
 * itself never fires, so testing the reject path needs an empty
 * accounts pool — that's what mobileLoginRejectFixture provides.
 */

import { mobileLoginRejectTest as test, expect } from "./fixtures.js";
import { openMyApps } from "./helpers.js";

test.describe("Mobile signer — login reject", () => {
  // FIXME — host-side `getIsAuthenticated()` returns true even with
  // `accounts: []` + `setLoginBehavior("reject")` + `simulateDisconnect`
  // in beforeEach. The iframe-side assertions (connect-prompt visible,
  // my-apps-account absent) DO pass — so the product correctly treats
  // the reject. But the host's auth flag doesn't agree with that state.
  //
  // Possible SDK-side behaviours that would explain it:
  //  (a) isAuthenticated defaults to true on a fresh test host and
  //      simulateDisconnect doesn't override past page.reload().
  //  (b) The host treats "any accounts available OR any login attempt"
  //      as authenticated regardless of the outcome.
  //
  // Need a confirm from the host-api-test-sdk team on the intended
  // semantics of `getIsAuthenticated()` before re-enabling. The iframe-
  // side coverage of the reject path is already present in
  // mobile-signer.spec.ts via the connect-prompt-visible + account-
  // absent shape; this test was meant to add the host-side independent
  // oracle.
  test.fixme("product stays unauthenticated and shows the connect prompt", async ({ testHost }) => {
    await testHost.setLoginBehavior("reject");
    await testHost.page.reload();

    // The product still loads (app-grid is rendered before signer connects).
    // Don't waitForAppReady — its inner waits are sized for the
    // connected case. Wait for the iframe to attach the grid directly.
    const frame = testHost.productFrame();
    await frame.locator('[data-testid="app-grid"]')
      .waitFor({ state: "attached", timeout: 60_000 });

    await openMyApps(frame);

    // Connect-prompt visible, account text never appears. The negative
    // assertion is load-bearing — without it a regression where the
    // product treats reject as success (e.g. ignores the host's response)
    // would slip through.
    await expect(frame.locator('[data-testid="my-apps-connect-prompt"]'))
      .toBeVisible({ timeout: 30_000 });
    await expect(frame.locator('[data-testid="my-apps-account"]'))
      .not.toBeVisible();

    expect(
      await testHost.getIsAuthenticated(),
      "host must NOT record the user as authenticated after login=reject",
    ).toBe(false);
  });
});
