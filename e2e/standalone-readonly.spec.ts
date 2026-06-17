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
 * Tier 2 — out-of-host (standalone readonly) tripwire.
 *
 * playground-app is designed to be loaded inside Polkadot Desktop or
 * Polkadot Mobile (the "host"). Per CLAUDE.md:
 *
 *   "outside Polkadot Desktop / Polkadot Mobile, CloudStorageClient.fetchJson
 *    and fetchBytes throw CloudStorageHostUnavailableError. The registry grid
 *    degrades to placeholder icons and missing metadata in plain browsers."
 *
 * The intent is graceful degradation, NOT a friendly readonly mode — most
 * dynamic content depends on the host transport. The tests below catch the
 * regression where the page goes from "degraded but renders" to "white
 * screen / uncaught exception on load" — the silent failure mode that
 * would happen if someone removes a fallback path in the host-detection
 * code.
 *
 * Intentionally NOT importing from ./fixtures.js — these tests must run
 * WITHOUT the host fixture (the whole point is no-host load). They use
 * Playwright's bare `test` and navigate via plain page.goto().
 *
 * Global setup (./setup.ts) still runs once before all projects; that
 * setup queries the registry contract via the host SDK and so on a clean
 * machine without funder seed will fail loudly. That's a constraint of
 * the suite as a whole (not specific to this file) and is documented in
 * e2e/README.md.
 */

import { test, expect } from "@playwright/test";

const PRODUCT_URL = process.env.PRODUCT_URL ?? "http://localhost:5173";

test.describe("standalone readonly — out-of-host load", () => {
  test("loads without crashing the page", async ({ page }) => {
    // Collect uncaught exceptions so we can flag UNEXPECTED ones. Out-of-host,
    // the product-sdk-chain-client throws "Host provider unavailable" by
    // design — that one we tolerate (it's the explicit graceful-degradation
    // signal). Anything ELSE bubbling to window is a regression.
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });

    // React must have mounted into #root. If the bundle threw on mount,
    // #root stays empty or is replaced by an error-boundary fallback.
    const root = page.locator("#root");
    await expect(root).toBeVisible();
    await expect(root).not.toBeEmpty();

    // The known/expected error: chain-client refuses to operate outside
    // a Polkadot host. Filter it out. Anything else is an unexpected
    // regression.
    const EXPECTED_OUT_OF_HOST_ERROR_RE =
      /Host provider unavailable for chain/i;
    const unexpected = pageErrors
      .map((e) => e.message)
      .filter((m) => !EXPECTED_OUT_OF_HOST_ERROR_RE.test(m));
    expect(
      unexpected,
      "page must not throw UNEXPECTED uncaught exceptions on out-of-host load " +
        '(the "Host provider unavailable" error is tolerated by design)',
    ).toEqual([]);
  });

  test("the left-rail nav renders (proves the React shell mounted, not just an HTML skeleton)", async ({ page }) => {
    // The left rail is rendered unconditionally in App.tsx (it lives above
    // any data-fetching gates). If it's not present, either the app didn't
    // mount or the rail was conditionally hidden — either way it's a
    // regression worth catching.
    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="nav-playground"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="nav-apps"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-profile"]')).toBeVisible();
  });

  test("does not display authenticated-only UI when the host is absent", async ({ page }) => {
    // Two-part check for "no host detected." Stage 5 adversarial review
    // caught that asserting only on publish-app-btn was ambiguous — that
    // button is also hidden for non-admin in-host signers (PR #163), so
    // the assertion could pass for the wrong reason. Tightened with a
    // tighter "no signer connected" check below.
    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="nav-apps"]')).toBeVisible({ timeout: 30_000 });

    // publish-app-btn is admin-only (PR #163); absent here for two
    // possible reasons (no host OR non-admin). Keep this check because
    // the leak we want to catch is publish-button-in-anonymous, but the
    // tighter check below pins down "no host" specifically.
    await expect(page.locator('[data-testid="publish-app-btn"]'))
      .toHaveCount(0);

    // Navigate into the Profile tab (My Apps view) and verify the
    // connect-prompt is shown rather than a connected-account display.
    // `my-apps-account` only renders when the signer reaches `connected`
    // state (the `!targetAddress` early-return path in MyApps wraps the
    // connect-prompt; the connected branch wraps the account display).
    // In-host signers ALWAYS reach connected (host attaches an account);
    // out-of-host they never can. So the absence of `my-apps-account`
    // while in the Profile view is a tight "no host detected" signal
    // that doesn't false-pass for non-admin in-host users.
    await page.locator('[data-testid="nav-profile"]').click();
    await expect(page.locator('[data-testid="my-apps-connect-prompt"]'))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="my-apps-account"]'))
      .toHaveCount(0);
  });
});
