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
 * Mobile smoke tests — run only under the `mobile-chrome` Playwright
 * project (Pixel 7 viewport). Catches regressions in the mobile-first
 * layout without doubling the desktop chain query load.
 */

import { test, expect } from "./fixtures.js";
import { waitForAppReady, waitForAnyCard, cardFor, openDetailPanel } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";

test.describe("mobile — smoke", () => {
  test("home grid renders the fixture card on a mobile viewport", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    await expect(
      cardFor(frame, FIXTURE_DOMAIN),
      "fixture card must be visible in the recents grid on Pixel 7 viewport",
    ).toBeVisible({ timeout: 60_000 });
  });

  test("detail panel opens on a mobile viewport", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(panel).toBeVisible();
  });
});
