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
 * Layer (b) — points_index leaderboard stress.
 *
 * Regression guard for the `OrderedIndexNodeTooLarge` failure mode found
 * upstream. With T=4 + K=u128 + V=Address, internal B-tree nodes overflow
 * the 416-byte storage cap at ~31 inserted rows. T=3 survives 240+. This
 * test reproduces the failure shape by driving N tied accounts into a
 * single bucket of `points_index` and confirms `get_top_builders` reads
 * the full page back cleanly.
 *
 * Driving pattern (same as `scripts/smoke-test-points.ts`): the DEV signer
 * is blacklisted up front, then publishes N apps with
 * `owner: { isSome: true, value: USER_i }`. Each USER_i is a synthetic
 * H160 — none of them ever sign, but each one is credited DEPLOY_XP on the
 * first publish for that owner. After N publishes the leaderboard holds
 * exactly one tied bucket of size N at score DEPLOY_XP.
 *
 * Configure via env:
 *   LOAD_BUILDERS  number of synthetic owners (default 50)
 *
 * Cost: one publish per builder. On a local dev-node ~1s each; on staging
 * (PPN finalized) ~30s each. LOAD_BUILDERS=50 ≈ 25min on staging, seconds
 * on local. Bump to 96+ for an explicit reproduction of the failure shape
 * the upstream report observed.
 *
 * Skips on Paseo by default. Set `STAGING_SURI=<funded mnemonic-or-//suri>`
 * to run against `@staging/playground-registry` on Paseo Next.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  WRITE_TX_OPTS,
  canWrite,
  destroyHandles,
  devAccount,
  ensureMapped,
  getHandles,
  type DevAccount,
} from "./setup";
import { XP_VALUES } from "../../src/xpValues";

const BUILDERS = Number(process.env.LOAD_BUILDERS ?? "50");
// Raw on-chain points for a first deploy — single source of truth, matches the
// contract's `DEPLOY_XP`. Each builder publishes exactly one (first) app.
const DEPLOY_XP = XP_VALUES.deploy;

const RUN = Date.now().toString(36);
const D = (label: string) => `pts-${RUN}-${label}.dot`;

const VISIBILITY_PUBLIC = 1;
const NO_MODDED_FROM = "" as const;
const FAKE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

/// Synthesize a deterministic H160 from an integer index, salted with `RUN`
/// so each test invocation uses FRESH owners. Critical because the chain
/// state from a prior failed run persists: re-using `0x...0001` across runs
/// would compound XP and complicate the "all tied at DEPLOY_XP" assertion,
/// and (more dangerously) it makes the contract take a different code path
/// (`cur > 0` branch in `award_points`) on the second run than the first,
/// masking real bugs in the fresh-account path.
///
/// Layout: 8-byte hi salt from Date.now() || 12-byte index suffix.
const RUN_HEX = Date.now().toString(16).padStart(16, "0").slice(-16);
function fakeOwner(i: number): `0x${string}` {
  const suffix = i.toString(16).padStart(24, "0");
  return `0x${RUN_HEX}${suffix}` as `0x${string}`;
}

let alice: DevAccount;

function txAs(account: DevAccount) {
  return { ...WRITE_TX_OPTS, signer: account.signer, origin: account.ss58 };
}

beforeAll(async () => {
  alice = devAccount("Alice", "//Alice");
  if (canWrite()) {
    await ensureMapped(alice);
    // Print the registry address up front so a stale cdm.json (e.g. after a
    // `cdm deploy` without a follow-up `cdm i`) is obvious before burning
    // ~30s/tx on the old contract.
    const { registryAddress } = await getHandles();
    process.stderr.write(`  [stress] registry address: ${registryAddress}\n`);
  }
}, 60_000);

afterAll(async () => {
  await destroyHandles();
});

/// Mirrors `submitWithRetry` in sorting-load.test.ts: on a non-retryable
/// failure, dry-run the same call via `.query()` (which surfaces the
/// revert payload the dispatch error swallows) and inline it in the
/// thrown message. Used here without the retry loop because every tx in
/// this test is at `waitFor: "finalized"` already.
async function submitWithDryRunOnFail(
  label: string,
  build: () => Promise<any>,
  dryRunOnFail: () => Promise<{ success?: boolean; value?: unknown }>,
): Promise<void> {
  try {
    const result = await build();
    if (result?.ok !== true) {
      let revertInfo = "";
      try {
        const dry = await dryRunOnFail();
        const valueStr = JSON.stringify(dry.value, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        );
        revertInfo = ` | dry-run: success=${dry.success}, value=${valueStr}`;
      } catch (dryErr) {
        revertInfo = ` | dry-run threw: ${(dryErr as Error).message}`;
      }
      throw new Error(
        `${label} returned ok=${String(result?.ok)} (hash=${result?.txHash ?? "n/a"})${revertInfo}`,
      );
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    let revertInfo = "";
    try {
      const dry = await dryRunOnFail();
      const valueStr = JSON.stringify(dry.value, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      revertInfo = ` | dry-run: success=${dry.success}, value=${valueStr}`;
    } catch (dryErr) {
      revertInfo = ` | dry-run threw: ${(dryErr as Error).message}`;
    }
    throw new Error(`${label} failed: ${msg}${revertInfo}`, { cause: err });
  }
}

describe("registry points_index — leaderboard stress", () => {
  it.skipIf(!canWrite())(
    `${BUILDERS} tied builders in points_index`,
    async () => {
      const { registry } = await getHandles();
      const reg = registry as any;

      // Blacklist Alice (DEV) so the publishes credit USER_i, not Alice.
      // Idempotent — re-running against the same chain is fine.
      await submitWithDryRunOnFail(
        "setBlacklisted(DEV)",
        () => reg.setBlacklisted.tx([alice.h160], true, txAs(alice)),
        () => reg.setBlacklisted.query([alice.h160], true, { origin: alice.ss58 }),
      );

      // Publish N apps. After each, the i-th USER lands at exactly DEPLOY_XP.
      // Every publish takes points_index from N entries to N+1 entries at the
      // same score bucket — this is the exact shape that pre-fix triggers
      // `OrderedIndexNodeTooLarge` once internal nodes need to split.
      const owners: Array<`0x${string}`> = [];
      const t0 = Date.now();
      for (let i = 0; i < BUILDERS; i++) {
        const owner = fakeOwner(i + 1); // skip 0x00...00 (zero address)
        owners.push(owner);
        const domain = D(`b-${i}`);
        const txStart = Date.now();
        await submitWithDryRunOnFail(
          `publish #${i} ${domain} (owner=${owner})`,
          () =>
            reg.publish.tx(
              domain,
              FAKE_CID,
              VISIBILITY_PUBLIC,
              { isSome: true, value: owner },
              NO_MODDED_FROM,
              false,
              false,
              txAs(alice),
            ),
          () =>
            reg.publish.query(
              domain,
              FAKE_CID,
              VISIBILITY_PUBLIC,
              { isSome: true, value: owner },
              NO_MODDED_FROM,
              false,
              false,
              { origin: alice.ss58 },
            ),
        );
        const dt = ((Date.now() - txStart) / 1000).toFixed(1);
        const total = ((Date.now() - t0) / 1000).toFixed(0);
        process.stderr.write(
          `  [stress] publish #${i}/${BUILDERS} done in ${dt}s (cumulative ${total}s)\n`,
        );
      }

      // Index read at scale must succeed and be correctly ordered — this is the
      // regression guard for the OrderedIndex stack-overflow / node-too-large
      // bugs: pre-fix the writes trapped before reaching here, and an over-full
      // tree would fail this paginated read. Post-fix: a full BUILDERS-sized
      // page comes back in non-increasing score order.
      const page: any = await reg.getTopBuilders.query(0, BUILDERS);
      expect(page.success).toBe(true);
      const entries = page.value as Array<{ account: string; score: bigint }>;
      expect(entries.length).toBe(BUILDERS);
      const scores = entries.map((e) => Number(e.score));
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }

      // Every builder we published must have been credited DEPLOY_XP. Checked
      // per-account via getPoints, not leaderboard membership: this contract is
      // long-lived (carries entries from earlier runs / the smoke test), so this
      // run's builders — all tied at DEPLOY_XP — won't all fit in a single
      // top-N page once other accounts exist. The per-account read confirms the
      // award + index update landed for each one regardless of global rank.
      for (const o of owners) {
        const pts = Number((await reg.getPoints.query(o)).value);
        expect(pts).toBe(DEPLOY_XP);
      }
    },
    // ~30s/tx finalized on PPN: 50 builders ≈ 25 min, 100 ≈ 50 min. Pin a
    // generous ceiling so the summit-scale 150 override survives.
    7_200_000,
  );
});
