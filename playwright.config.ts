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

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/setup.ts",
  fullyParallel: false, // overridden per project — see chromium-reads below
  workers: 1,           // CI overrides via --workers flag (3 for reads job, 1 for writes)
  timeout: 240_000,     // CI cold-start (Vite + Paseo connect) can eat ~2 min before tests start
  expect: { timeout: 60_000 },
  retries: process.env.CI ? 2 : 1,
  reporter: [["html", { open: "never" }], ["list"]],

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },

  projects: [
    {
      // Read-only tests — no chain writes, no funder spend. Safe to run in
      // parallel; CI passes --workers=3 to this project's job. Splitting reads
      // out lets PR-time wall-clock drop from ~15 min to ~8 min without
      // skipping any tests.
      name: "chromium-reads",
      use: { ...devices["Desktop Chrome"] },
      fullyParallel: true,
      // `publish.spec.ts` is kept out — PR #163 made the modal admin-only,
      // so the file is scheduled for deletion per TESTING_PLAN.md but kept
      // in-tree as a reference until Layer (d) component tests pick up the
      // PublishModal state machine. Excluding it from chromium-reads (and
      // it's already absent from chromium-writes' testMatch) means it
      // doesn't run anywhere.
      testIgnore: /(mobile-smoke|mobile-signer(-login-reject)?|publish|unpublish|rate|my-apps|events|builder-deploy)\.spec\.ts/,
    },
    {
      // Write tests — sign with the funder, must serialize. Single funder
      // account = strict nonce ordering, so workers stay at 1 and the CI job
      // keeps the e2e-funder concurrency group that already exists.
      name: "chromium-writes",
      use: { ...devices["Desktop Chrome"] },
      fullyParallel: false,
      // builder-deploy: tier 1 (preflight) is read-only, but tier 2 (the
      // E2E_BUILDER_DEPLOY=1 paid deploy) writes — route the whole spec here
      // so the paid tier can never race the funder's nonce serialization.
      testMatch: /(unpublish|rate|my-apps|events|builder-deploy)\.spec\.ts/,
    },
    {
      // Mobile-signer tests — exercise the RFC-0009 login flow, post-login
      // signing, permission rejection, and disconnect/reconnect via the
      // host-api-test-sdk's setLoginBehavior / setPermissionBehavior /
      // simulate* helpers. The "signing after login" test writes a tx (rates
      // the fixture app), so this also burns funder nonces; routed to the
      // e2e-writes CI job so it serializes behind chromium-writes inside the
      // e2e-funder concurrency group.
      //
      // `mobile-signer-login-reject.spec.ts` is a sibling spec that uses a
      // different fixture (no accounts pre-injected, so the login flow
      // actually fires). Both match the regex below.
      name: "chromium-mobile-signer",
      use: { ...devices["Desktop Chrome"] },
      fullyParallel: false,
      testMatch: /mobile-signer(-login-reject)?\.spec\.ts/,
    },
    {
      // Mobile viewport tripwire — narrow on purpose. The product is mobile-
      // first per CLAUDE.md, so we keep a Pixel 7 smoke check on the recents
      // grid + detail panel without doubling the desktop suite's chain load.
      // Read-only; runs alongside chromium-reads in the e2e-reads CI job.
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile-smoke\.spec\.ts/,
    },
  ],

  webServer: {
    command: "pnpm dev --port 5173",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // Vite first-compile in CI can take ~60s; allow headroom
    // Tag synthetic traffic so production dashboards can filter it out via
    // `!journey.tag:e2e-*`. Vite picks VITE_* env vars up at build time and
    // injects into import.meta.env. Sentry env stays "e2e" so PR-preview /
    // prod runs are still cleanly separable from test runs.
    env: {
      VITE_SENTRY_TAG: process.env.VITE_SENTRY_TAG ?? "e2e",
      VITE_SENTRY_ENV: process.env.VITE_SENTRY_ENV ?? "e2e",
    },
  },
});
