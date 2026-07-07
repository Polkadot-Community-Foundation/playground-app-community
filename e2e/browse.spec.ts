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
import { waitForAppReady, waitForAnyCard, waitForCardMetadata, cardFor } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";
import fixtureMetadata from "./fixture-metadata.json" with { type: "json" };

test.describe("browse — recents grid", () => {
  test("homepage shows app cards from the registry", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    const count = await frame.locator('[data-testid="app-grid"] [data-testid="app-card"]').count();
    expect(count, "homepage should render at least one app card from the registry")
      .toBeGreaterThanOrEqual(1);
  });

  test("the e2e fixture domain appears in the grid", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible({ timeout: 60_000 });
  });

  test("no category is selected on first load", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    // Additive model: the default is "nothing selected" (show all), so the
    // leading toggle reads its inert "filters" state and no tag pill is active.
    const toggle = frame.locator('[data-testid="filters-toggle"]');
    await expect(toggle).toHaveAttribute("data-active", "false");
    await expect(toggle).toHaveText("filters");
    await expect(frame.locator('[data-testid="filter-pill"][data-tag="utility"]'))
      .toHaveAttribute("data-active", "false");
  });

  test("clicking a tag pill activates it and arms remove-all-filters", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    const utilityPill = frame.locator('[data-testid="filter-pill"][data-tag="utility"]');
    const toggle = frame.locator('[data-testid="filters-toggle"]');

    // Starts off (nothing-selected default); clicking applies this category and
    // flips the leading toggle into its clickable "remove filters" state.
    await expect(utilityPill).toHaveAttribute("data-active", "false");
    await utilityPill.click();
    await expect(utilityPill).toHaveAttribute("data-active", "true");
    await expect(toggle).toHaveAttribute("data-active", "true");
    await expect(toggle).toHaveText("remove filters");
  });

  test("remove all filters clears every selection", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    const utilityPill = frame.locator('[data-testid="filter-pill"][data-tag="utility"]');
    const toggle = frame.locator('[data-testid="filters-toggle"]');

    // Select a category so the clear action is exercised, not a no-op.
    await utilityPill.click();
    await expect(toggle).toHaveAttribute("data-active", "true");

    await toggle.click();
    await expect(utilityPill).toHaveAttribute("data-active", "false");
    await expect(toggle).toHaveAttribute("data-active", "false");
    await expect(toggle).toHaveText("filters");
  });

  test("selecting a category shows only cards of that tag", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    // Wait for the fixture's metadata to load so its data-tag is populated.
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);

    const fixtureTag = fixtureMetadata.tag;
    const pillLocator = frame.locator(`[data-testid="filter-pill"][data-tag="${fixtureTag}"]`);

    // Default: nothing selected → the fixture (tagged fixtureTag) is visible.
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();

    // Apply that category → the fixture stays, but every card of a different
    // bucket leaves the grid. Expressing this as a count==0 assertion gives a
    // clear failure message and avoids the no-loops-over-test-cases rule.
    await pillLocator.click();
    await expect(pillLocator).toHaveAttribute("data-active", "true");
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();

    const otherTagged = frame.locator(
      `[data-testid="app-grid"] [data-testid="app-card"]:not([data-tag="${fixtureTag}"])`,
    );
    await expect(
      otherTagged,
      `only '${fixtureTag}' cards should remain after selecting that category`,
    ).toHaveCount(0);
  });

  test("the moddable fixture card shows the Moddable badge", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    // Badge visibility depends on metadata.repository, which lands with
    // the rest of the metadata fetch.
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);

    const card = cardFor(frame, FIXTURE_DOMAIN);
    await expect(card).toHaveAttribute("data-moddable", "true");
    await expect(card.locator('[data-testid="card-moddable-badge"]')).toBeVisible();
  });

  test("pinned cards appear before any unpinned card in the grid", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);

    // App.tsx builds the visible list as `[...pinned, ...rest]` (see the
    // useMemo around the `filtered` array). The assertion: walking the
    // grid top-to-bottom, once you see the first `data-pinned="false"`
    // card, every subsequent card must also be `data-pinned="false"`.
    const cardsLocator = frame.locator('[data-testid="app-grid"] [data-testid="app-card"]');
    const pinnedValues = await cardsLocator.evaluateAll(
      (els) => els.map((el) => el.getAttribute("data-pinned")),
    );

    const pinnedCount = pinnedValues.filter((v) => v === "true").length;
    const unpinnedCount = pinnedValues.filter((v) => v === "false").length;

    // Guard: the assertion is only meaningful with at least one of each.
    // If the registry currently has zero pinned apps (or all pinned),
    // the test would pass vacuously — skip with a clear reason instead.
    test.skip(
      pinnedCount === 0 || unpinnedCount === 0,
      `need at least one pinned AND one unpinned card to exercise the ordering; saw pinned=${pinnedCount} unpinned=${unpinnedCount}`,
    );

    const firstUnpinnedIdx = pinnedValues.findIndex((v) => v === "false");
    const pinnedAfterUnpinned = pinnedValues
      .slice(firstUnpinnedIdx + 1)
      .filter((v) => v === "true").length;
    expect(
      pinnedAfterUnpinned,
      `no pinned card may appear after the first unpinned card (saw ${pinnedAfterUnpinned} out-of-order pinned cards)`,
    ).toBe(0);
  });

  // The search input is a CLIENT-SIDE filter over already-loaded entries —
  // see the placeholder "Filter loaded apps by name or domain…" and the
  // filter callback in App.tsx around the `filtered` useMemo. These tests
  // exercise that filter shape (name + domain substring match,
  // case-insensitive) and the adversarial inputs the filter must tolerate
  // without crashing.
  test.describe("search filter", () => {
    test("typing the fixture name filters the grid to that card", async ({ testHost }) => {
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);
      // Metadata must be loaded; the filter reads name from metadata, not
      // just the domain, and the fixture's display name is what we type.
      await waitForCardMetadata(frame, FIXTURE_DOMAIN);

      // Pre-condition: at least one non-fixture card must be visible so
      // the filter is exercised. The live registry has many entries —
      // a count > 1 is essentially always true, but assert it so the
      // test is self-defending against a future "only the fixture is
      // registered" world.
      const beforeCount = await frame
        .locator('[data-testid="app-grid"] [data-testid="app-card"]').count();
      expect(beforeCount, "need >=2 cards before filter for the test to be meaningful")
        .toBeGreaterThan(1);

      await frame.locator('[data-testid="search-input"]').fill("Playground E2E Fixture");

      // Fixture stays visible.
      await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();

      // No other card is visible (the filter is name+domain substring;
      // "Playground E2E Fixture" matches only the fixture's display name).
      const otherCards = frame.locator(
        `[data-testid="app-grid"] [data-testid="app-card"]:not([data-domain="${FIXTURE_DOMAIN}"])`,
      );
      await expect(
        otherCards,
        `only the fixture should match the search term`,
      ).toHaveCount(0);
    });

    test("a search with no matches shows the filtered empty state", async ({ testHost }) => {
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      // Use a string that genuinely cannot match — a UUID-shaped token
      // with no real-world meaning. Avoid known fixture substrings.
      await frame.locator('[data-testid="search-input"]')
        .fill("zzz-no-such-app-9f3e1c70-2db4");

      // The grid empties; the empty-state-filtered banner appears with
      // "Try clearing the search." copy. Both testids exist in App.tsx
      // (data-testid="empty-state-filtered" is the filtered version;
      // data-testid="empty-state" is the truly-empty registry).
      const banner = frame.locator('[data-testid="empty-state-filtered"]');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Try clearing the search");

      // And no card remains in the grid.
      await expect(
        frame.locator('[data-testid="app-grid"] [data-testid="app-card"]'),
      ).toHaveCount(0);
    });

    test("regex special characters in the search query do not crash the filter", async ({ testHost }) => {
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      // The current filter uses `String.prototype.includes` — no regex
      // construction — so specials should be treated as literals and not
      // throw. Asserts that today AND tripwires a future regression if
      // someone rewrites the filter to `new RegExp(search)` without
      // escaping. Cover the high-signal specials: anchor, dot, brackets,
      // backslash, alternation.
      const adversarial = ".*^$+?()[]{}|\\";
      await frame.locator('[data-testid="search-input"]').fill(adversarial);

      // Either the filtered empty-state appears (correct) or some card
      // legitimately contains one of those characters (extremely unlikely
      // on the live registry). Either way the app must not be in a
      // crashed state — assert the grid container is still ATTACHED to
      // the DOM (it may be visually hidden by CSS when empty; what we
      // care about is that React didn't unmount it on a thrown error).
      await expect(
        frame.locator('[data-testid="app-grid"]'),
        "grid must still be rendered (not unmounted by a thrown error)",
      ).toBeAttached();

      // And the search input still holds the value we typed — proves the
      // React tree didn't unmount + remount during the filter pass.
      await expect(frame.locator('[data-testid="search-input"]'))
        .toHaveValue(adversarial);
    });

    test("a very long search query does not crash the filter", async ({ testHost }) => {
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      // 4KB — well past any UI-realistic length. The filter is O(n) over
      // loaded entries × O(m) per `includes`, so a long string is just
      // slow `includes`, not a correctness risk. Test exists to catch a
      // future change that quadratics on query length (e.g. naive regex
      // build).
      const longQuery = "a".repeat(4096);
      await frame.locator('[data-testid="search-input"]').fill(longQuery);

      // Grid stays in DOM (not unmounted); empty-state-filtered banner
      // surfaces as the visible affordance. Same as the regex-specials
      // test above — use toBeAttached for the grid since it's hidden by
      // CSS when empty.
      await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
      await expect(frame.locator('[data-testid="empty-state-filtered"]'))
        .toBeVisible();
    });

    test("emoji search query renders + filters without crashing", async ({ testHost }) => {
      // Emoji are multi-byte UTF-16 surrogate pairs; a filter that splits or
      // truncates them ("query.slice(0, n)") could produce an invalid surrogate
      // and throw downstream. Plain `String.prototype.includes` handles them
      // fine — this test pins that behaviour so a future "be helpful and
      // normalise the input" doesn't regress it.
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      const emojiQuery = "🦄🚀💫";
      await frame.locator('[data-testid="search-input"]').fill(emojiQuery);

      // No card on the live registry should match; filtered-empty surfaces.
      await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
      await expect(frame.locator('[data-testid="empty-state-filtered"]'))
        .toBeVisible();

      // Input value round-trips intact (no surrogate split).
      await expect(frame.locator('[data-testid="search-input"]'))
        .toHaveValue(emojiQuery);
    });

    test("right-to-left script in the query doesn't crash + round-trips", async ({ testHost }) => {
      // RTL (Arabic) text introduces bidirectional rendering issues in some
      // browsers but the filter logic itself should treat the codepoints
      // opaquely. Pin "no crash + value round-trips" so a future "rtl-aware
      // normalise" rewrite doesn't silently change what we filter on.
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      const rtlQuery = "مرحبا";
      await frame.locator('[data-testid="search-input"]').fill(rtlQuery);

      await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
      await expect(frame.locator('[data-testid="search-input"]'))
        .toHaveValue(rtlQuery);
    });

    test("zero-width characters in the query don't crash the filter", async ({ testHost }) => {
      // Zero-width joiner / non-joiner / space are common copy-paste artefacts
      // (especially from Slack / Discord). They render to nothing but count
      // as codepoints — a filter that errors on "invisible content" or that
      // tries to render the value into a regex without escaping could fail.
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      // ZWJ + ZWNJ + ZWSP + LRM + RLM — five different zero-width specials.
      const zeroWidthQuery = "‍‌​‎‏";
      await frame.locator('[data-testid="search-input"]').fill(zeroWidthQuery);

      await expect(frame.locator('[data-testid="app-grid"]')).toBeAttached();
      // No card on the live registry has any of these in its domain or
      // name; filtered-empty banner should surface.
      await expect(frame.locator('[data-testid="empty-state-filtered"]'))
        .toBeVisible();
    });

    test("the clear (×) button resets the filter and restores the grid", async ({ testHost }) => {
      // App.tsx renders the clear button conditionally — only when
      // `search` is non-empty (aria-label="Clear filter"). Clicking it
      // calls setSearch("") which empties the filter and brings every
      // loaded card back. Catches the regression where the clear button
      // becomes a no-op (e.g. if onClick gets stripped) or where the
      // conditional render flips inverted.
      const frame = await waitForAppReady(testHost);
      await waitForAnyCard(frame);

      const beforeCount = await frame
        .locator('[data-testid="app-grid"] [data-testid="app-card"]').count();
      expect(beforeCount, "need >=1 card before filter for the assertion to be meaningful")
        .toBeGreaterThan(0);

      await frame.locator('[data-testid="search-input"]')
        .fill("zzz-no-such-app-9f3e1c70-2db4");
      await expect(frame.locator('[data-testid="empty-state-filtered"]'))
        .toBeVisible();

      // The clear button is only rendered when search is non-empty —
      // so visibility itself is a pre-condition of the click.
      const clearBtn = frame.locator('button[aria-label="Clear filter"]');
      await expect(clearBtn).toBeVisible();
      await clearBtn.click();

      // Input value cleared.
      await expect(frame.locator('[data-testid="search-input"]'))
        .toHaveValue("");

      // Grid back to the pre-filter card count. Asserting count rather
      // than visibility-of-fixture avoids coupling to which card the
      // fixture happens to be among many — the contract being tested is
      // "filter cleared → all loaded cards re-shown".
      await expect(
        frame.locator('[data-testid="app-grid"] [data-testid="app-card"]'),
      ).toHaveCount(beforeCount);

      // And the filtered-empty banner is gone.
      await expect(frame.locator('[data-testid="empty-state-filtered"]'))
        .not.toBeVisible();
    });
  });

  test("Moddable-only toggle hides cards without a repository", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);

    const nonModdable = frame.locator(
      '[data-testid="app-grid"] [data-testid="app-card"][data-moddable="false"]',
    );

    // Pre-condition: at least one non-moddable (or unloaded) card must be
    // visible *before* we toggle, otherwise the post-toggle "count == 0"
    // assertion below would pass vacuously without exercising the filter.
    // On the live registry this is essentially always true (most apps
    // don't publish a repository), but the assertion makes the test
    // self-defending against a future world where everything is moddable.
    const before = await nonModdable.count();
    expect(before, "test needs at least one non-moddable/unloaded card to be meaningful")
      .toBeGreaterThan(0);

    const toggle = frame.locator('[data-testid="filter-moddable-toggle"]');
    await expect(toggle).toHaveAttribute("data-active", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("data-active", "true");

    // Fixture is moddable, so it must remain visible.
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();

    // No card with data-moddable="false" should be visible while the toggle
    // is active. Counting via :not catches both non-moddable and unloaded
    // cards (both render as data-moddable="false").
    await expect(
      nonModdable,
      "no non-moddable cards should be visible while Moddable-only is on",
    ).toHaveCount(0);
  });

  test("Show sites toggle is on by default and hides site cards when turned off", async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForAnyCard(frame);
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);

    const toggle = frame.locator('[data-testid="filter-site-toggle"]');
    // Default: Show sites is on, so the grid shows everything (sites mixed in).
    await expect(toggle).toHaveAttribute("data-active", "true");
    // The utility fixture is a non-site card — visible regardless of the toggle.
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();

    // Turning Show sites off removes only the site cards; the non-site fixture
    // stays. (count==0 holds trivially if the live registry has no sites — the
    // assertion still guards against a site card surviving the toggle.)
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-active", "false");
    await expect(
      frame.locator(`[data-testid="app-grid"] [data-testid="app-card"][data-tag="site"]`),
      "no site cards should be visible while Show sites is off",
    ).toHaveCount(0);
    await expect(cardFor(frame, FIXTURE_DOMAIN)).toBeVisible();

    // Back on → default grid restored.
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-active", "true");
  });
});
