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
import { waitForAppReady, openMyApps, cardFor, openDetailPanel } from "./helpers.js";
import { SIGNER } from "./accounts.js";
import { FIXTURE_DOMAIN } from "./fixture.js";
import { publishDomain, waitForApp, VISIBILITY_PRIVATE } from "./registry.js";

test.describe("My Apps view", () => {
  test("shows the connected account and hides the publish button for non-admins", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await openMyApps(frame);

    // The connect prompt may appear briefly, then resolve to the connected
    // view — wait for the connected state directly.
    const accountEl = frame.locator('[data-testid="my-apps-account"]');
    await expect(accountEl).toBeVisible({ timeout: 30_000 });

    // The visible identity should be a registry username or deterministic
    // generated name, never the host wallet label or raw H160 fallback.
    const accountText = (await accountEl.textContent())?.trim() ?? "";
    expect(accountText).not.toBe("");
    expect(accountText).not.toBe(SIGNER.name);
    expect(accountText).not.toBe(SIGNER.h160);
    expect(accountText).not.toMatch(/^0x[a-f0-9]{40}$/i);

    // PR #163 (2026-05-11): the publish button is gated on `registry.isAdmin`
    // — it must be hidden for any signer who isn't sudo-granted admin. The
    // funder we use for e2e is intentionally not an admin, so this assertion
    // is the regression catcher for "admin gate accidentally removed", which
    // at Summit would expose the modal to every attendee. The admin-side
    // happy path (modal opens for an admin signer) is covered at Layer (d)
    // when those tests land — see TESTING_PLAN.md.
    await expect(frame.locator('[data-testid="publish-app-btn"]')).not.toBeVisible();
  });

  test("the fixture domain (owned by the funder) appears in the My Apps grid", async ({ testHost }) => {
    // The fixture domain is owned by the SIGNER (the funder in CI) via
    // setup.ts's seeding step — so when we sign in as the funder, the
    // fixture must surface in the My Apps grid. Catches the regression
    // where the my-apps filter accidentally narrows by visibility or
    // some other field beyond ownership (e.g. listing only Public apps
    // when the spec is "all apps you own, including Private").
    //
    // No throwaway publish needed for this assertion — the fixture is
    // pre-existing and stable across runs, so it doesn't burn a funder
    // nonce. The existing "freshly published domain appears in the My
    // Apps grid" test below covers the post-publish surface separately
    // (write path, uses the throwaway fixture).
    const frame = await waitForAppReady(testHost);
    await openMyApps(frame);

    // Wait for the connected state — without an account hydrated, My Apps
    // shows the connect prompt and the grid is empty by design.
    await expect(frame.locator('[data-testid="my-apps-account"]'))
      .toBeVisible({ timeout: 30_000 });

    await expect(
      cardFor(frame, FIXTURE_DOMAIN, { grid: "my-apps" }),
      "fixture domain must surface in My Apps when signed in as its owner",
    ).toBeVisible({ timeout: 30_000 });
  });
});

const PUBLISHED_METADATA = {
  name: "E2E Visibility Target",
  description: "Created by my-apps.spec.ts; cleaned up by the throwaway fixture.",
  repository: "https://github.com/paritytech/playground-app",
  tag: "utility",
};

/**
 * Reload the iframe + reach the My Apps view. Used by tests that publish a
 * domain server-side and then need the iframe to re-render with that entry
 * visible.
 */
async function reloadIntoMyApps(testHost: import("@parity/host-api-test-sdk/playwright").TestHost) {
  await testHost.page.reload();
  await testHost.waitForConnection(60_000);
  const frame = testHost.productFrame();
  await frame.locator('[data-testid="app-grid"]').waitFor({ state: "attached", timeout: 30_000 });
  await openMyApps(frame);
  return frame;
}

// Owners use the visibility toggle (Public ↔ Private) to hide / show their
// own apps. There is no owner-facing "delete" — hard delete is sudo/admin
// only and lives in a different code path. These tests assert the
// visibility-toggle UX matches the spec: Private apps disappear from the
// browse grid, remain visible to the owner in My Apps with a Private badge,
// and reappear in browse when set back to Public.
test.describe("My Apps view — visibility workflow", () => {
  // FIXME — uses Node-side `publishDomain` which routes through
  // BulletinClient.create({ environment: "paseo" }), and that client
  // requires a host transport (chain-client internally). In Node, it
  // throws `Host provider unavailable for chain`. Per TESTING_PLAN.md
  // §Relocations, this test is slated to move to Layer (d) component
  // test for the visibility-toggle state machine. Fixme'd until the
  // relocation happens. The "ownership" surface is covered above by
  // the funder-owned fixture test which doesn't require a write.
  test.fixme("a freshly published domain appears in the My Apps grid", async ({ testHost, throwaway }) => {
    // Publish Private: this test only asserts the card surfaces in My Apps
    // (which filters by ownership, not visibility), so going Private keeps
    // the fixture out of the public grid even when teardown unpublish fails.
    // The Public→Private→Public flow is covered separately by the fixme'd
    // tests below; the recents-grid surface is covered by events.spec.ts.
    await publishDomain(throwaway.domain, PUBLISHED_METADATA, VISIBILITY_PRIVATE);
    // publishDomain blocks on waitForApp internally, but reload + indexer
    // catch-up still races — give the iframe up to 30s to surface the card.
    await waitForApp(throwaway.domain, 30_000);

    const frame = await reloadIntoMyApps(testHost);

    // Card lives in the my-apps grid, not recents — brand-new entries may
    // not have surfaced in the recents pagination yet.
    await expect(cardFor(frame, throwaway.domain, { grid: "my-apps" }))
      .toBeVisible({ timeout: 30_000 });
  });

  // FIXME(product-sdk descriptors): iframe tx submission hangs because
  // chain-client's bundled @parity/product-sdk-descriptors is out of sync
  // with the current Paseo Asset Hub runtime — submit promise never settles.
  // Reactivate once descriptors are regenerated and chain-client is bumped.
  test.fixme("switching an app to Private removes it from recents and shows a 'Private' badge in My Apps", async ({ testHost, throwaway }) => {
    await publishDomain(throwaway.domain, PUBLISHED_METADATA);
    await waitForApp(throwaway.domain, 30_000);

    const frame = await reloadIntoMyApps(testHost);

    const panel = await openDetailPanel(frame, throwaway.domain, { grid: "my-apps" });

    // Guard: confirm the panel recognises the connected user as the owner —
    // without this, a "visibility section not found" failure would obscure
    // the real cause (panel didn't pick up ownership).
    await expect(
      panel,
      "detail panel must recognise SIGNER as owner before visibility toggle is reachable",
    ).toHaveAttribute("data-is-owner", "true");

    await expect(panel.locator('[data-testid="detail-visibility-section"]')).toBeVisible();

    await panel.locator('[data-testid="visibility-private-btn"]').click();
    await expect(panel.locator('[data-testid="visibility-private-btn"]'))
      .toHaveAttribute("data-active", "true", { timeout: 60_000 });

    // Card disappears from recents (private apps are filtered out for non-
    // owner viewers — see the `entry.visibility !== VISIBILITY_PUBLIC &&
    // !isOwnApp` guard in App.tsx). Catches a regression where that
    // condition gets inverted or short-circuited.
    await expect(cardFor(frame, throwaway.domain, { grid: "recents" }))
      .not.toBeVisible({ timeout: 30_000 });

    // Card stays in My Apps with a Private badge — the spec promise:
    // "Hidden apps disappear from the browse grid but remain in My Apps".
    const myCard = cardFor(frame, throwaway.domain, { grid: "my-apps" });
    await expect(myCard).toBeVisible();
    await expect(myCard.locator(".card-visibility-badge")).toContainText("Private");
  });

  // FIXME(product-sdk descriptors): iframe tx submission hangs because
  // chain-client's bundled @parity/product-sdk-descriptors is out of sync
  // with the current Paseo Asset Hub runtime — submit promise never settles.
  // Reactivate once descriptors are regenerated and chain-client is bumped.
  test.fixme("switching back to Public restores the card to the recents grid", async ({ testHost, throwaway }) => {
    await publishDomain(throwaway.domain, PUBLISHED_METADATA);
    await waitForApp(throwaway.domain, 30_000);

    const frame = await reloadIntoMyApps(testHost);
    const panel = await openDetailPanel(frame, throwaway.domain, { grid: "my-apps" });

    // Step 1 — set private.
    await panel.locator('[data-testid="visibility-private-btn"]').click();
    await expect(panel.locator('[data-testid="visibility-private-btn"]'))
      .toHaveAttribute("data-active", "true", { timeout: 60_000 });

    // Confirm the card is actually gone from recents before flipping back —
    // without this, the "back to public" assertion could pass spuriously
    // if the card never left recents in the first place.
    await expect(cardFor(frame, throwaway.domain, { grid: "recents" }))
      .not.toBeVisible({ timeout: 30_000 });

    // Step 2 — flip back to public from the same panel.
    await panel.locator('[data-testid="visibility-public-btn"]').click();
    await expect(panel.locator('[data-testid="visibility-public-btn"]'))
      .toHaveAttribute("data-active", "true", { timeout: 60_000 });

    // Card returns to recents.
    await expect(cardFor(frame, throwaway.domain, { grid: "recents" }))
      .toBeVisible({ timeout: 30_000 });

    // Private badge no longer shown on the My Apps card.
    const myCard = cardFor(frame, throwaway.domain, { grid: "my-apps" });
    await expect(myCard.locator(".card-visibility-badge")).not.toBeVisible();
  });
});
