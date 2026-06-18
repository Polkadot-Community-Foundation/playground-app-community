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
 * Playwright test fixtures — embed the playground-app inside a host iframe
 * with the @parity/host-api-test-sdk and provide an auto-signing account.
 *
 * SIGNER is the dedicated funder when E2E_FUNDER_SEED is set (CI), or
 * //Alice as a fallback for local runs without the secret. See ./accounts.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import {
  createTestHostFixture,
  PASEO_ASSET_HUB,
  type TestHost,
} from "@parity/host-api-test-sdk/playwright";
import { SIGNER, uniqueDomain } from "./accounts.js";
import { unpublishDomain } from "./registry.js";

const PRODUCT_URL = process.env.PRODUCT_URL ?? "http://localhost:5173";

// Patterns of console messages / unhandled rejections we want to silence
// during test runs only — they're harmless but loud third-party output that
// drowns out our own diagnostics. Add patterns here when something becomes
// noisy; remove once the upstream cause is fixed.
//
// NOTE: this filter is test-only. It's installed via context.addInitScript
// in the beforeEach below, so it doesn't affect production / `pnpm dev`.
const TEST_CONSOLE_NOISE: RegExp[] = [
  /Incompatible runtime entry.*ReviveApi_trace_call/i,
];

// Built into the page via addInitScript. Source must be self-contained (no
// closures over Node-side variables); the patterns are interpolated as a
// string. Using `.source` + flags reconstructs the regex inside the page.
const consoleFilterSource = `
(() => {
  const NOISE = ${JSON.stringify(TEST_CONSOLE_NOISE.map(r => ({ source: r.source, flags: r.flags })))}.map(p => new RegExp(p.source, p.flags));
  const describe = (v) => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message + "\\n" + (v.stack || "");
    try { return JSON.stringify(v); } catch { try { return String(v); } catch { return ""; } }
  };
  const isNoise = (args) => {
    const blob = args.map(describe).join(" ");
    return blob !== "" && NOISE.some(p => p.test(blob));
  };
  for (const level of ["error", "warn", "log"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { if (!isNoise(args)) orig(...args); };
  }
  window.addEventListener("unhandledrejection", e => {
    if (isNoise([e.reason])) e.preventDefault();
  });
  window.addEventListener("error", e => {
    if (isNoise([e.error, e.message])) e.preventDefault();
  });
})();
`;

// dotNsId the playground app sends to the host on `getProductAccount`. The
// app derives this from `window.location.hostname` (see src/config.ts) —
// on localhost dev (PRODUCT_URL=http://localhost:5173) it resolves to
// `localhost:5173`. We mirror that here so the test host's productAccounts
// map keys match what the iframe will actually request.
//
// Why this matters: without an entry under this dotNsId, the test host
// falls back to deriving `//Bob//<dotNsId>/<index>` — a fresh, unfunded
// account on Paseo Asset Hub. Every write tx then silently drops at
// signSubmitAndWatch (no balance → no inclusion → promise never settles),
// which previously got misdiagnosed as a chain-client/descriptors bug
// (see PR #142, closed without merge).
const PRODUCT_DOTNS_ID = (() => {
  try {
    const url = new URL(PRODUCT_URL);
    if (url.hostname === "localhost") return url.host; // "localhost:5173"
    if (url.hostname.endsWith(".dot.li")) return url.hostname.slice(0, -3);
    if (url.hostname.endsWith(".dot")) return url.hostname;
    return "playground.dot";
  } catch {
    return "playground.dot";
  }
})();

// productAccounts maps the dotNsId the iframe asks for → the account the
// test host should return from getProductAccount(). Extracted to named
// consts (rather than inlining the literal) so the structural guard
// below has something to read AND so the maps don't drift between fixture
// definitions. Stage 5 adversarial review of PR #167 introduced this
// guard — see the throw block for the bug class it prevents.
const PRODUCT_ACCOUNTS_FOR_SIGNER = {
  [`${PRODUCT_DOTNS_ID}/0`]: { name: SIGNER.name, uri: SIGNER.uri },
};

const PRODUCT_ACCOUNTS_FOR_BOB = {
  [`${PRODUCT_DOTNS_ID}/0`]: "bob",
};

// Structural guard — PR #142 (closed without merge) spent a day debugging
// missing-productAccounts as a "product-sdk-descriptors out of sync" bug.
// If a future refactor strips the productAccounts wiring above, fast-fail
// at module load instead of letting tests hang forever at signSubmitAndWatch
// (the host falls back to //Bob/<dotNsId>/0, an unfunded derived account;
// tx is silently dropped, promise never settles, no clue why).
//
// Module-load means `pnpm exec playwright test --list` catches the misconfig
// in seconds rather than after a 60s tx hang on the first write test run.
if (
  Object.keys(PRODUCT_ACCOUNTS_FOR_SIGNER).length === 0 ||
  !PRODUCT_ACCOUNTS_FOR_SIGNER[`${PRODUCT_DOTNS_ID}/0`]
) {
  throw new Error(
    `fixtures.ts: productAccounts missing the SIGNER mapping for ` +
      `${PRODUCT_DOTNS_ID}/0. Without this, the test host derives ` +
      `//Bob/<dotNsId>/0 — an unfunded account — and every write tx ` +
      `hangs at signSubmitAndWatch. See PR #142 (closed) for the ` +
      `misdiagnosis cycle this guard prevents.`,
  );
}

const signerFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: [{ name: SIGNER.name, uri: SIGNER.uri }],
  productAccounts: PRODUCT_ACCOUNTS_FOR_SIGNER,
  chain: PASEO_ASSET_HUB,
});

const bobFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: ["bob"],
  productAccounts: PRODUCT_ACCOUNTS_FOR_BOB,
  chain: PASEO_ASSET_HUB,
});

// Mobile-signer fixture — currently structurally identical to signerFixture
// at the test SDK level. Named separately so test files can express intent
// (this test exercises the mobile login flow) and so we can swap behaviour
// here without touching every spec.
//
// Why not "zero-state" (accounts: [])?  Promoted from external-review
// feedback 2026-05-12 (see TESTING_PLAN.md §Signing modes), but on
// implementing we found the test SDK has no way to provision accounts
// POST-login — the `accounts:` array IS the host's account pool. With
// `accounts: []`, setLoginBehavior('success') resolves the login but the
// product gets a connected state with no account, my-apps-account never
// renders, test hangs.
//
// The cold-start init path the reviewer was concerned about IS still
// exercised: every mobile-signer test does `await testHost.page.reload()`
// which is the actual cold-start trigger (the iframe reinitializes the
// product SDK from scratch). `simulateDisconnect()` in beforeEach resets
// the host's auth state between tests so each test re-drives the login
// rather than getting `alreadyConnected`.
const mobileSignerFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: [{ name: SIGNER.name, uri: SIGNER.uri }],
  productAccounts: PRODUCT_ACCOUNTS_FOR_SIGNER,
  chain: PASEO_ASSET_HUB,
});

// Separate fixture for the login-REJECT test specifically. Reject only
// fires when the product has no accounts available — with accounts pre-
// injected via `accounts: [SIGNER]` (as in mobileSignerFixture above),
// the legacy-account path short-circuits the login flow and the host
// flips isAuthenticated=true regardless of setLoginBehavior. So
// asserting `getIsAuthenticated() === false` after a reject would
// require the product to have actually tried to log in — which only
// happens with no pre-injected accounts.
//
// This fixture is only used by the login-reject spec. Other mobile-
// signer tests need the SIGNER post-login (success / signing /
// permission / disconnect / reconnect) and use mobileSignerFixture.
const mobileLoginRejectFixture = createTestHostFixture({
  productUrl: PRODUCT_URL,
  accounts: [],
  chain: PASEO_ASSET_HUB,
});

export interface Throwaway {
  /** A unique `e2e-<ts>-<rand>.dot` domain. The slug (without `.dot`) is also exposed for tests that fill the publish modal. */
  domain: string;
  slug: string;
}

/**
 * `throwaway` yields a fresh, unique .dot domain per test and unpublishes
 * it on teardown (best-effort). Tests that publish a throwaway domain
 * (server-side or via the UI) should pull this fixture so the registry
 * doesn't accumulate orphans across runs.
 *
 * The fixture is lazy — only tests that destructure `throwaway` pay the
 * cost. If the test never publishes, the teardown unpublish is a no-op.
 */
export const test = base
  .extend<{ testHost: TestHost }>(signerFixture)
  .extend<{ throwaway: Throwaway }>({
    throwaway: async ({}, use) => {
      const domain = uniqueDomain();
      const slug = domain.replace(/\.dot$/, "");
      await use({ domain, slug });
      // Best-effort cleanup. unpublishDomain swallows + logs failures so a
      // teardown error does not mask the test's actual failure.
      await unpublishDomain(domain);
    },
  });

// Install the filter on the browser context BEFORE testHost navigates the
// page. addInitScript queues the script for every new document load in the
// context, so it applies to both the host shell and the playground iframe.
test.beforeEach(async ({ page }) => {
  await page.context().addInitScript(consoleFilterSource);
});

// ─── Bulletin preimage seeding ─────────────────────────────────────────
//
// The iframe's `BulletinClient.fetchJson(cid)` routes through the host's
// preimage subscription (per CLAUDE.md "container-only delivery"). In
// production, the host (Polkadot Desktop / Mobile) connects to the real
// Bulletin chain and fetches the preimage by its blake2b-256 hash. In
// host-api-test-sdk's test host, the preimage store starts EMPTY — the
// host has no Bulletin chain access of its own.
//
// Without seeding, every `data-metadata-loaded="true"` waiter hangs the
// full 60s: the iframe subscribes to preimageLookup(blake2b256(cid))
// against a host that has no matching entry. The subscription never
// resolves. Setup.ts's `gatewayFetchJson` warms a separate Node-side
// HTTP cache that the iframe doesn't touch — useful for Node-side reads,
// irrelevant to the iframe.
//
// Fix: read fixture-metadata.json, compute the same byte representation
// that `publishDomain` used to compute the CID, and call
// `testHost.seedPreimage(bytes)` on every test host. The SDK derives the
// key as blake2b-256(bytes) — matching what the iframe extracts from
// the CID's multihash digest.
//
// One-time read at module load.
const __fixturesDir = dirname(fileURLToPath(import.meta.url));
// Exported so tests that do `testHost.page.reload()` can re-seed after
// the reload — the host's preimage store doesn't persist across page
// reloads (verified locally + CI 2026-05-12). Tests that don't reload
// rely on the beforeEach seed below and don't need the export.
export const FIXTURE_METADATA_BYTES = new TextEncoder().encode(
  JSON.stringify(
    JSON.parse(readFileSync(join(__fixturesDir, "fixture-metadata.json"), "utf-8")),
  ),
);

test.beforeEach(async ({ testHost }) => {
  await testHost.seedPreimage(FIXTURE_METADATA_BYTES);
});

export const bobTest = base.extend<{ testHost: TestHost }>(bobFixture);
bobTest.beforeEach(async ({ page }) => {
  await page.context().addInitScript(consoleFilterSource);
});
bobTest.beforeEach(async ({ testHost }) => {
  await testHost.seedPreimage(FIXTURE_METADATA_BYTES);
});

// Zero-state mobile-signer test — see mobileSignerFixture above for
// the rationale. Use this for any test that needs to exercise the
// cold-start login flow without a pre-existing account.
export const mobileSignerTest = base.extend<{ testHost: TestHost }>(mobileSignerFixture);
mobileSignerTest.beforeEach(async ({ page }) => {
  await page.context().addInitScript(consoleFilterSource);
});
mobileSignerTest.beforeEach(async ({ testHost }) => {
  await testHost.seedPreimage(FIXTURE_METADATA_BYTES);
});

// Login-reject variant — see mobileLoginRejectFixture above. Lives in
// its own spec file (mobile-signer-login-reject.spec.ts) because the
// fixture diverges from mobileSignerTest (no accounts pre-injected).
export const mobileLoginRejectTest = base.extend<{ testHost: TestHost }>(mobileLoginRejectFixture);
mobileLoginRejectTest.beforeEach(async ({ page }) => {
  await page.context().addInitScript(consoleFilterSource);
});
mobileLoginRejectTest.beforeEach(async ({ testHost }) => {
  // The test host's `isAuthenticated` flag defaults to true on a fresh
  // host. simulateDisconnect resets it so the login-reject assertion
  // (`getIsAuthenticated() === false` after login=reject) starts from a
  // clean unauthenticated baseline. Without this, the assertion fails
  // because the host's auth state never had a chance to be set TO false
  // BY the rejected login — it stayed at the true default.
  await testHost.simulateDisconnect();
});

export { expect } from "@playwright/test";
