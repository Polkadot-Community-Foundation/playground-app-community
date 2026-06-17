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
 * E2E test balance canary.
 *
 * Watches the SIGNER's account balance on Paseo Asset Hub. There is a
 * single underlying balance — substrate ss58 and Ethereum h160 addressing
 * forms point at the same account once `Revive.map_account()` has linked
 * them (`setup.ts` calls `ensureSignerMapped()` idempotently on first
 * run). One balance covers both Revive contract calls and the underlying
 * tx fee / storage deposit.
 *
 * Below threshold, logs a warning and opens a GitHub issue. Does NOT
 * fail the test run — funding is a manual ops task. Faucet at
 * https://faucet.polkadot.io/?network=pah.
 */

import { queryBalance } from "./chain.js";
import { SIGNER } from "./accounts.js";

const LOW_THRESHOLD_DOT = BigInt(process.env.SIGNER_LOW_THRESHOLD_DOT ?? "10");
const DOT = 10_000_000_000n;

export async function getSignerBalance(): Promise<bigint> {
  return await queryBalance(SIGNER.address);
}

export async function checkFunderAndWarn(): Promise<void> {
  try {
    const balance = await getSignerBalance();
    const balanceDot = balance / DOT;
    console.log(`[e2e setup] SIGNER (${SIGNER.name})`);
    console.log(`[e2e setup]   balance: ${balanceDot} PAS (${SIGNER.address} / ${SIGNER.h160})`);

    if (balanceDot < LOW_THRESHOLD_DOT) {
      console.warn(
        `[e2e setup] ⚠️ SIGNER balance is below ${LOW_THRESHOLD_DOT} PAS — write tests may fail`,
      );
      await createLowBalanceIssue(balance);
    }
  } catch (err) {
    console.warn(`[e2e setup] Could not check SIGNER balance: ${err}`);
  }
}

async function createLowBalanceIssue(balance: bigint): Promise<void> {
  const ghToken = process.env.GITHUB_TOKEN;
  const ghRepo = process.env.GITHUB_REPO;
  if (!ghToken || !ghRepo) {
    console.warn("[e2e setup] GITHUB_TOKEN or GITHUB_REPO not set — skipping issue creation");
    return;
  }

  const title = "⚠️ E2E test signer balance is low — please top up";

  try {
    const searchRes = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${ghRepo} is:open in:title "${title}"`)}`,
      { headers: { Authorization: `Bearer ${ghToken}` } },
    );
    if (!searchRes.ok) {
      console.warn(`[e2e setup] GitHub search API returned ${searchRes.status} — skipping issue check`);
      return;
    }
    const searchData = (await searchRes.json()) as { total_count: number };
    if (searchData.total_count > 0) {
      console.log("[e2e setup] Low-balance issue already open — skipping creation");
      return;
    }

    const body = `${SIGNER.name}'s balance is **${balance / DOT} PAS** (${balance} planck).\n\nAddress: \`${SIGNER.address}\` (h160: \`${SIGNER.h160}\`)\n\nFaucet: https://faucet.polkadot.io/?network=pah`;
    const createRes = await fetch(`https://api.github.com/repos/${ghRepo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body }),
    });
    if (!createRes.ok) {
      console.warn(`[e2e setup] GitHub issue creation returned ${createRes.status}`);
      return;
    }
    console.log("[e2e setup] Created low-balance issue on GitHub");
  } catch (err) {
    console.warn(`[e2e setup] Failed to create GitHub issue: ${err}`);
  }
}
