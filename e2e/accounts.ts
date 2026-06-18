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
 * Test signer for e2e tests.
 *
 * SIGNER is selected ONCE at module load based on whether the
 * `E2E_FUNDER_SEED` env var is set:
 *
 *   - **set**   → uses the dedicated funder (CI uses this via GH secret)
 *   - **unset** → uses //Alice as a local-dev convenience fallback
 *
 * The choice is env-based, NOT runtime-balance-based. If E2E_FUNDER_SEED
 * is set but the funder is empty, tests will fail with "Invalid: Payment"
 * — there is no auto-fallback to Alice. The canary in funder.ts opens a
 * GitHub issue when the funder's balance dips, so a human can top it up
 * rather than silently switching identities mid-suite (which would muddle
 * test results across runs).
 *
 * Why a dedicated funder rather than //Alice as canonical: Alice is shared
 * with every other test suite + script in the Polkadot ecosystem, so her
 * balance is perpetually at risk of being drained by unrelated traffic.
 * Paseo's faucet also refuses to refill well-known dev accounts. The funder is a fresh, isolated address — faucet-friendly and
 * not subject to shared-fate drains. Alice as a local-dev fallback works
 * because read tests don't sign anything; write tests are `.skip`-ed
 * anyway when run without the secret.
 */

import { seedToAccount } from "@parity/product-sdk-keys";

// Standard Substrate dev mnemonic — public, used by every Polkadot dev tool.
const DEV_PHRASE =
  "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

export interface TestAccount {
  name: string;
  /** Substrate URI passed to the host fixture (mnemonic or dev path like //Alice). */
  uri: string;
  address: string;
  h160: `0x${string}`;
}

function makeAccount(name: string, uri: string): TestAccount {
  const isDevPath = uri.startsWith("//");
  const acct = isDevPath
    ? seedToAccount(DEV_PHRASE, uri)
    : seedToAccount(uri, "");
  return {
    name,
    uri,
    address: acct.ss58Address,
    h160: acct.h160Address,
  };
}

/** Primary signer — funder when E2E_FUNDER_SEED is set, else //Alice. */
export const SIGNER: TestAccount = (() => {
  const seed = process.env.E2E_FUNDER_SEED;
  if (seed) return makeAccount("E2E Funder", seed);
  return makeAccount("Alice (fallback)", "//Alice");
})();

/** Generate a unique .dot domain for write tests (timestamp + random suffix). */
export function uniqueDomain(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `e2e-${ts}-${rand}.dot`;
}
