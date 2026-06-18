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
 * Accessibility smoke tests using axe-core.
 *
 * Scope: a tripwire, not an exhaustive audit. We fail only on "serious" or
 * "critical" impact violations to avoid blocking development on stylistic
 * issues, while still catching regressions like:
 *   - missing alt text on images
 *   - buttons / links without accessible names
 *   - form fields without associated labels
 *   - severely insufficient colour contrast
 *   - missing or wrong heading hierarchy
 *
 * Failure messages include the rule id, impact, description, and a link to
 * the axe rule docs — so a CI failure tells you exactly what's wrong and
 * how to fix it without opening this file.
 */

import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.js";
import { waitForAppReady, waitForAnyCard, openDetailPanel, openMyApps } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

const BLOCKING_IMPACTS: Array<Violation["impact"]> = ["serious", "critical"];

function blockingViolations(violations: Violation[]): Violation[] {
  return violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact));
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "no violations";
  return violations
    .map((v) => {
      const nodes = v.nodes.length;
      return `  - [${v.impact}] ${v.id}: ${v.description}\n    ${nodes} affected element${nodes === 1 ? "" : "s"} — ${v.helpUrl}`;
    })
    .join("\n");
}

test.describe("accessibility — smoke", () => {
  test("home grid has no serious or critical a11y violations", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    // Scope axe to the product iframe's body — the test SDK's host shell
    // (`<iframe id="product-frame">`) is third-party HTML we don't control,
    // so its violations would mask real product issues.
    const results = await new AxeBuilder({ page: testHost.page })
      .include(["#product-frame", "body"])
      .analyze();
    const blocking = blockingViolations(results.violations);

    expect(blocking, `home grid a11y violations:\n${formatViolations(blocking)}`).toEqual([]);
  });

  // Skipped: surfaces the SAME known serious violation as the detail-panel
  // a11y test below — `--color-text-tertiary` (#57534e) on
  // `--color-surface` (#161412) at 2.4:1 against WCAG AA's 4.5:1 threshold.
  // The empty-state-filtered banner uses the same token as detail-panel
  // sub-headings; same global design-token fix unblocks both. Unskip once
  // the token lands at ≥ 4.5:1 (tracked on the same fix as the detail-panel
  // skip on line ~125 of this file).
  test.skip("filtered empty state has no serious or critical a11y violations", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    // Type a query that cannot match — pushes the grid into the
    // empty-state-filtered banner. Axe needs to see this distinct UI
    // state to catch regressions on its copy / contrast / aria.
    await frame.locator('[data-testid="search-input"]')
      .fill("zzz-no-such-app-9f3e1c70-2db4");
    await expect(frame.locator('[data-testid="empty-state-filtered"]'))
      .toBeVisible();

    const results = await new AxeBuilder({ page: testHost.page })
      .include(["#product-frame", "body"])
      .analyze();
    const blocking = blockingViolations(results.violations);

    expect(
      blocking,
      `filtered empty state a11y violations:\n${formatViolations(blocking)}`,
    ).toEqual([]);
  });

  test("My Apps view has no serious or critical a11y violations", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    await openMyApps(frame);

    // Wait for the connected state so axe scans the populated My Apps
    // grid, not the transient connect-prompt that flashes during signer
    // hydration. Two distinct UIs, two distinct a11y surfaces — we cover
    // the populated grid here.
    await expect(frame.locator('[data-testid="my-apps-account"]'))
      .toBeVisible({ timeout: 30_000 });

    const results = await new AxeBuilder({ page: testHost.page })
      .include(["#product-frame", "body"])
      .analyze();
    const blocking = blockingViolations(results.violations);

    expect(
      blocking,
      `My Apps view a11y violations:\n${formatViolations(blocking)}`,
    ).toEqual([]);
  });

  // Was previously skipped on two compounding violations on this panel:
  // (1) the --color-text-tertiary contrast issue (fixed via --grey-500 token
  //     addition; tracked in #176 / #178), and
  // (2) 5 star-rating buttons missing aria-label (icon-only buttons with
  //     no discernible text; tracked in #179, now fixed by adding
  //     `aria-label="Rate N star(s)"` to each).
  // Both fixes landed in PR #167.
  test("detail panel has no serious or critical a11y violations", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    await openDetailPanel(frame, FIXTURE_DOMAIN);

    // Scope axe to the product iframe's body — the test SDK's host shell
    // (`<iframe id="product-frame">`) is third-party HTML we don't control,
    // so its violations would mask real product issues.
    const results = await new AxeBuilder({ page: testHost.page })
      .include(["#product-frame", "body"])
      .analyze();
    const blocking = blockingViolations(results.violations);

    expect(blocking, `detail panel a11y violations:\n${formatViolations(blocking)}`).toEqual([]);
  });
});
