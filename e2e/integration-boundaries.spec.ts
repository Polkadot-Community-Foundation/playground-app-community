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
 * Integration boundary — what happens to the browse-side UI when the
 * host emits unexpected events (disconnect, reconnect, repeated cycles)?
 *
 * mobile-signer.spec.ts covers the *signed-in* disconnect path; these
 * tests cover the *unauthenticated* browse path — the regression
 * surface is different (no session key to invalidate, but the iframe
 * still subscribes to event streams that route via the host).
 *
 * Uses the dev-signer fixture (accounts pre-injected) — disconnect
 * here means "host transport went away mid-browse", not "user logged
 * out". The assertion focus is "React tree stays attached, grid
 * doesn't unmount, error handler doesn't crash the app".
 */

import { test, expect } from "./fixtures.js";
import { waitForAppReady, waitForAnyCard, cardFor, openDetailPanel } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";

test.describe("integration boundaries — host disconnect during browse", () => {
  test("simulated host disconnect mid-browse keeps the grid attached", async ({ testHost }) => {
    // The product subscribes to ContractEmitted events for live updates.
    // When the host's transport drops, the subscription error path runs.
    // Pin "grid stays in the DOM" — a crashed error handler that
    // unmounted the App would fail this assertion.
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    const beforeCount = await frame
      .locator('[data-testid="app-grid"] [data-testid="app-card"]')
      .count();
    expect(beforeCount, "need >=1 card pre-disconnect for the assertion to mean anything")
      .toBeGreaterThan(0);

    await testHost.simulateDisconnect();

    // App tree still rendered, fixture card still in the DOM (cached
    // state — disconnect doesn't wipe what we already loaded).
    await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();
  });

  test("reconnect after a browse-time disconnect keeps the grid usable", async ({ testHost }) => {
    // Reverse of the above. Confirms the iframe doesn't enter a broken
    // state after a disconnect/reconnect cycle — clicking a card after
    // reconnect should still open the detail panel.
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    await testHost.simulateDisconnect();
    await testHost.simulateReconnect();

    // Grid still alive, fixture interaction still works.
    await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
    await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(frame.locator('[data-testid="app-detail-panel"]'))
      .toBeVisible();
  });

  test("repeated disconnect/reconnect cycles don't leak listeners or crash", async ({ testHost }) => {
    // Subscription cleanup regression catcher. The event-subscribe useEffect
    // is supposed to tear down its sub on cleanup; a missing unsubscribe
    // would silently accumulate listeners on each cycle. We can't directly
    // assert listener count from outside the iframe, but we CAN assert
    // that the UI remains responsive after N cycles — a leaked-handler
    // bug typically surfaces as either a hang or a thrown error in the
    // next event-handler that re-enters the unmounted tree.
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    for (let i = 0; i < 5; i++) {
      await testHost.simulateDisconnect();
      await testHost.simulateReconnect();
    }

    await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();
  });
});
