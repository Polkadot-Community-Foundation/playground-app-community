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
import { waitForAppReady, waitForAnyCard, cardFor } from "./helpers.js";
import { publishDomain } from "./registry.js";

// Requires SIGNER to be a funded, h160-mapped account — one balance,
// accessible via either ss58 or h160 (Revive.map_account() links them;
// setup.ts handles mapping). CI runs with E2E_FUNDER_SEED set via repo
// secret; local runs without the secret will fail loudly. See
// e2e/README.md "Signing identity".
test.describe("event subscription", () => {
  // FIXME — uses Node-side `publishDomain` which routes through
  // BulletinClient.create({ environment: "paseo" }), and that client
  // requires a host transport (chain-client internally). In Node, it
  // throws `Host provider unavailable for chain`. Per TESTING_PLAN.md
  // §Relocations, this test is slated to move to Layer (d) as a
  // component test for the event reducer — the assertion (event fires
  // → grid re-renders) is reducer logic, not a chain-roundtrip test.
  // Fixme'd until the relocation happens.
  test.fixme("a newly published domain appears in the recents grid without reload", async ({ testHost, throwaway }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    // Sanity: the throwaway domain is unique per test, so there must not be
    // a leftover card for it before we publish. Catches any test-isolation
    // regression where a prior run's domain leaks through.
    await expect(
      cardFor(frame, throwaway.domain),
      `throwaway domain '${throwaway.domain}' must not be in the grid before publish`,
    ).toHaveCount(0);

    // Publish server-side. App.tsx subscribes to Published / Unpublished /
    // etc. on the registry contract and is expected to re-render the
    // recents grid live — without a page reload. If event subscription
    // breaks (transport, decoder, listener wiring), this is the only test
    // that would catch it; my-apps tests reload the page and would mask
    // the regression.
    await publishDomain(throwaway.domain, {
      name: "E2E Live Event",
      description: "Verifies the iframe picks up Published events without a reload.",
      repository: "https://github.com/paritytech/playground-app",
      tag: "utility",
    });

    // Generous timeout: chain block time + indexer + event delivery to the
    // iframe's WebSocket subscription typically lands in 6–12s, but cold-
    // start variance can stretch it.
    await expect(
      cardFor(frame, throwaway.domain),
      "newly published domain should surface in the recents grid via event subscription (no reload)",
    ).toBeVisible({ timeout: 60_000 });
  });
});
