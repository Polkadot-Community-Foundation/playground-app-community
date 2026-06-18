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
import { waitForAppReady, openDetailPanel, waitForCardMetadata } from "./helpers.js";
import { FIXTURE_DOMAIN } from "./fixture.js";
import fixtureMetadata from "./fixture-metadata.json" with { type: "json" };

test.describe("app detail panel", () => {
  test.beforeEach(async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);
  });

  test("opens when its card is clicked", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(panel).toBeVisible();
  });

  test("closes when the close button is clicked", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="detail-close-btn"]').click();
    await expect(panel).not.toBeVisible();
  });

  test("closes when the backdrop is clicked", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(panel).toBeVisible();

    await frame.locator('[data-testid="app-detail-backdrop"]').click({ position: { x: 5, y: 5 } });
    await expect(panel).not.toBeVisible();
  });

  test("closes when the Escape key is pressed", async ({ testHost }) => {
    // Escape handler is attached to the iframe window's keydown event
    // while the panel is mounted (src/App.tsx around line 491). This is
    // the keyboard-a11y close path; pairs with the close-button and
    // backdrop tests above. Catches a regression where the handler is
    // removed or the listener target changes.
    //
    // Important: the listener is on the IFRAME's window, not the host
    // page's window. We must press Escape on a locator inside the iframe
    // so the event bubbles to the right window. Targeting the close
    // button gives us a focusable in-iframe element without depending on
    // the panel itself accepting focus.
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="detail-close-btn"]').press("Escape");
    await expect(panel).not.toBeVisible();
  });

  test("shows the fixture's name, description, and repo link", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);

    // We own the fixture's metadata, so we can assert exact strings.
    await expect(panel.locator('[data-testid="detail-name"]')).toHaveText(fixtureMetadata.name);
    await expect(panel.locator('[data-testid="detail-description"]')).toHaveText(
      fixtureMetadata.description,
    );

    // The repo "link" is a span that copies the URL to clipboard on click
    // (not an <a href>), so we assert the value via `data-href` and the
    // visible text — that's the actual user-facing contract.
    const repoLink = panel.locator('[data-testid="detail-repo-link"]');
    await expect(repoLink).toBeVisible();
    await expect(repoLink).toHaveAttribute("data-href", fixtureMetadata.repository);
    // Visible text strips http(s):// + www. — so github.com/paritytech/playground-app remains.
    const visibleRepo = fixtureMetadata.repository.replace(/^https?:\/\/(www\.)?/, "");
    await expect(repoLink).toContainText(visibleRepo);
  });

  test("renders the readme as HTML, not raw markdown", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    const readme = panel.locator('[data-testid="detail-readme"]');
    await expect(readme).toBeVisible();

    // Structural: marked() must turn the leading "# Playground E2E Fixture"
    // into an <h1>. If markdown rendering breaks and the raw string leaks
    // into the DOM, this assertion fails (no <h1>).
    await expect(readme.locator("h1").first()).toHaveText("Playground E2E Fixture");
    // Catch raw-markdown leakage explicitly — the literal "# " line should
    // not appear as text.
    await expect(readme).not.toContainText("# Playground E2E Fixture");

    // And content from later in the readme is reachable too.
    await expect(readme).toContainText("E2E funder account");
  });

  test("shows the dot mod command for the domain", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);

    const cmd = panel.locator('[data-testid="mod-command"]');
    await expect(cmd).toBeVisible();
    const slug = FIXTURE_DOMAIN.replace(/\.dot$/, "");
    // toHaveText is exact (whitespace-trimmed): catches typos / regressions
    // that containText would let through (e.g. `dot mod foo-typo`).
    await expect(cmd).toHaveText(`dot mod ${slug}`);
  });

  test("shows the domain link with the https href and opens in a new tab", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);

    const link = panel.locator('[data-testid="detail-domain-link"]');
    await expect(link).toContainText(FIXTURE_DOMAIN);
    // Assert the actual href, not just the visible text — a regression that
    // strips/garbages the protocol would still pass a text-only check.
    await expect(link).toHaveAttribute("href", `https://${FIXTURE_DOMAIN}`);
    // target/rel are part of the link contract: navigation goes through the
    // host's openExternal in Desktop; in plain browsers it must open in a
    // new tab without leaking window.opener.
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("shows the fixture's tag", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await expect(panel.locator('[data-testid="detail-tag"]')).toHaveText(fixtureMetadata.tag);
  });

  test("Share button exposes the canonical share URL via data-href", async ({ testHost }) => {
    // We assert the href via data-href (not by reading the clipboard) because
    // clipboard access in iframes is gated by permissions Playwright doesn't
    // grant by default. The data-href IS the value passed to clipboard.writeText
    // in the click handler — see AppDetailPanel.copyText / shareUrl.
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);

    const share = panel.locator('[data-testid="detail-share-link"]');
    await expect(share).toBeVisible();
    const href = await share.getAttribute("data-href");
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.searchParams.get("app")).toBe(FIXTURE_DOMAIN);
    // Strips other query params — the share link is the canonical form.
    expect([...url.searchParams.keys()]).toEqual(["app"]);

    // Clicking gives feedback ("Link copied" + check icon).
    await share.click();
    await expect(share).toContainText("Link copied");
  });
});

// Deep linking: the panel is reflected in the iframe URL as ?app=<domain> so
// the post-deploy "Share your app" CTA produces a link that opens straight
// to the detail page. These tests live in the chromium-reads project (no
// funder spend) and exercise both the click→URL path and the URL→panel path.
//
// All evaluate() calls below run inside the iframe context: `frame.locator(':root')`
// resolves to <html> in the product iframe, so `window` is the iframe's window.
test.describe("app detail panel — deep linking", () => {
  test.beforeEach(async ({ testHost }) => {
    const frame = await waitForAppReady(testHost);
    await waitForCardMetadata(frame, FIXTURE_DOMAIN);
  });

  test("clicking a card adds ?app=<domain> to the iframe URL", async ({ testHost }) => {
    const frame = testHost.productFrame();
    await openDetailPanel(frame, FIXTURE_DOMAIN);

    const search = await frame.locator(":root").evaluate(() => window.location.search);
    expect(new URLSearchParams(search).get("app")).toBe(FIXTURE_DOMAIN);
  });

  test("closing the panel clears ?app= from the iframe URL", async ({ testHost }) => {
    const frame = testHost.productFrame();
    const panel = await openDetailPanel(frame, FIXTURE_DOMAIN);
    await panel.locator('[data-testid="detail-close-btn"]').click();
    await expect(panel).not.toBeVisible();

    const search = await frame.locator(":root").evaluate(() => window.location.search);
    expect(new URLSearchParams(search).get("app")).toBeNull();
  });

  test("?app=<domain> on initial load opens the panel for that domain", async ({ testHost }) => {
    // Catches a regression where the initial-mount effect either doesn't
    // fire or doesn't fall through to the on-demand fetch (the deep-linked
    // domain may not be loaded in the grid yet).
    const frame = testHost.productFrame();
    await frame.locator(":root").evaluate((_el, domain: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set("app", domain);
      window.location.replace(url.toString());
    }, FIXTURE_DOMAIN);

    const panel = frame.locator(
      `[data-testid="app-detail-panel"][data-domain="${FIXTURE_DOMAIN}"]`,
    );
    await expect(panel).toBeVisible({ timeout: 60_000 });
  });
});
