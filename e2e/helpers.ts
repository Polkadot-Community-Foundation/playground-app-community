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
 * Shared helpers for playground-app e2e tests.
 *
 * The app renders TWO grids in the DOM, both containing `AppCard`
 * components with `data-testid="app-card"`:
 *
 *   - `[data-testid="app-grid"]`     — the recents/browse grid
 *   - `[data-testid="my-apps-grid"]` — the My Apps grid (hidden when not active)
 *
 * Card-finding helpers default to the recents grid because that's what
 * most tests interact with. Tests that need to operate on the My Apps
 * grid (publish/delete flows) must pass `{ grid: "my-apps" }`.
 */

import type { TestHost } from "@parity/host-api-test-sdk/playwright";
import type { FrameLocator, Locator } from "@playwright/test";

export type GridScope = "recents" | "my-apps";

const GRID_SELECTOR: Record<GridScope, string> = {
  recents: '[data-testid="app-grid"]',
  "my-apps": '[data-testid="my-apps-grid"]',
};

interface ScopeOptions {
  grid?: GridScope;
}

interface WaitOptions extends ScopeOptions {
  timeout?: number;
}

/**
 * Wait for the playground-app to be ready inside the test host iframe.
 *
 * 1. Spektr handshake (`testHost.waitForConnection`)
 * 2. Left-rail mounted (proves the React shell rendered)
 * 3. Navigate to /apps and wait for the grid to attach — keeps the previous
 *    ready signal (grid mounted ⇒ contract+chain reachable) intact under
 *    the new router: the default route is PlaygroundTab which does NOT
 *    render the grid.
 *
 * Returns the FrameLocator for the product iframe.
 *
 * Default timeout is 120s — CI cold-starts (Vite compile + Paseo connect)
 * routinely take 60–90s, so the local 25s cadence isn't representative.
 */
export async function waitForAppReady(
  testHost: TestHost,
  options?: { timeout?: number },
): Promise<FrameLocator> {
  const timeout = options?.timeout ?? 120_000;
  const frame = testHost.productFrame();
  await testHost.waitForConnection(timeout);
  await frame.locator('[data-testid="nav-apps"]').waitFor({ state: "visible", timeout });
  await frame.locator('[data-testid="nav-apps"]').click();
  await frame.locator('[data-testid="app-grid"]').waitFor({ state: "attached", timeout });
  return frame;
}

/**
 * Wait for at least one card to be visible in the given grid (default: recents).
 *
 * Default timeout is 120s — registry queries from a cold chain client can
 * take 30–90s in CI before the first card renders.
 */
export async function waitForAnyCard(
  frame: FrameLocator,
  options?: WaitOptions,
): Promise<void> {
  const grid = options?.grid ?? "recents";
  const timeout = options?.timeout ?? 120_000;
  await frame.locator(`${GRID_SELECTOR[grid]} [data-testid="app-card"]`).first()
    .waitFor({ state: "visible", timeout });
}

/**
 * Locate the card for a specific domain in the given grid (default: recents).
 *
 * If the same domain appears in both grids (the connected account owns it),
 * scoping ensures we always operate on the requested side.
 */
export function cardFor(
  frame: FrameLocator,
  domain: string,
  options?: ScopeOptions,
): Locator {
  const grid = options?.grid ?? "recents";
  return frame.locator(`${GRID_SELECTOR[grid]} [data-testid="app-card"][data-domain="${domain}"]`);
}

/**
 * Wait until a card has metadata loaded (data-metadata-loaded="true") in
 * the given grid (default: recents). Use before asserting on metadata-
 * derived UI (name, description, icon, tag).
 *
 * Default timeout is 60s — globalSetup pre-warms the Bulletin gateway
 * cache, but CI cold-starts can still need 30–60s before metadata flows
 * into the iframe.
 */
export async function waitForCardMetadata(
  frame: FrameLocator,
  domain: string,
  options?: WaitOptions,
): Promise<void> {
  const grid = options?.grid ?? "recents";
  const timeout = options?.timeout ?? 60_000;
  const card = frame.locator(
    `${GRID_SELECTOR[grid]} [data-testid="app-card"][data-domain="${domain}"][data-metadata-loaded="true"]`,
  );
  await card.waitFor({ state: "visible", timeout });
}

/**
 * Open the detail panel for the given domain by clicking its card in the
 * specified grid (default: recents). Returns the panel locator after it
 * appears.
 */
export async function openDetailPanel(
  frame: FrameLocator,
  domain: string,
  options?: WaitOptions,
): Promise<Locator> {
  const timeout = options?.timeout ?? 60_000;
  const card = cardFor(frame, domain, options);
  await card.waitFor({ state: "visible", timeout });
  await card.click();
  const panel = frame.locator(`[data-testid="app-detail-panel"][data-domain="${domain}"]`);
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  return panel;
}

/**
 * Open the My Apps view via the left-rail Profile nav. Clicking Profile always
 * routes to /profile; the signer's connect flow runs in the background if not
 * already connected.
 */
export async function openMyApps(frame: FrameLocator): Promise<void> {
  await frame.locator('[data-testid="nav-profile"]').click();
}

/**
 * Return to the Apps grid via the left-rail Apps nav (replaces the old topbar
 * toggle-back from My Apps to recents).
 */
export async function openApps(frame: FrameLocator): Promise<void> {
  await frame.locator('[data-testid="nav-apps"]').click();
}
