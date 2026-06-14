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
 * Smoke-tests the @staging/playground-registry deployment.
 *
 * Exercises every points-relevant code path on a real chain (paseo-asset-
 * hub-next) and asserts exact scores so a regression in award logic shows
 * up as a failed scenario instead of a silent off-by-one.
 *
 * Setup model: one signer (DEV, the deployer who has PAS) signs every tx,
 * but ownership is assigned via the `owner: Some(...)` arg so each
 * scenario credits a distinct fake H160. DEV is added to the blacklist at
 * the top so it cannot accumulate points itself.
 *
 *   pnpm tsx scripts/smoke-test-points.ts
 *
 * KNOWN ISSUE: against the staging dev SURI on paseo-asset-hub-next, the
 * publish() path silently fails after best-block inclusion because the
 * signer's free balance cannot cover the storage-deposit reservation for
 * the new entries (info + metadata_uri + indices + points + OrderedIndex
 * nodes — ~500+ bytes). The dry-run (`.query()`) succeeds, confirming
 * contract correctness; only the funded production signer will execute
 * the full scenario list. Re-run from a topped-up account or with an
 * explicit `storageDepositLimit` option in `.tx()` to complete the suite.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { deriveH160 } from "@parity/product-sdk-address";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import cdmJsonRaw from "../cdm.json" with { type: "json" };
import { XP_VALUES } from "../src/xpValues";

const ASSET_HUB_WS =
  process.env.ASSET_HUB_WS_URL ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_SURI = "ensure coffee ripple degree senior grunt unit seek defense year spoon fix";
const PACKAGE = "@staging/playground-registry";
const VISIBILITY_PRIVATE = 0;
const VISIBILITY_PUBLIC = 1;
const NO_OWNER = { isSome: false, value: "0x0000000000000000000000000000000000000000" } as const;
// modded_from is now a plain `string` on the contract — "" means "no
// mod source" (the contract checks `is_empty()`). The previous
// `Option<String>` shape was incompatible with viem's tuple encoding
// (see src/publishFlow.ts comment).
const NO_MODDED_FROM = "" as const;

// Three fake H160s, derived per-run from the timestamp so re-running the
// smoke test produces fresh recipients each time (point balances are
// per-account, persist forever, and absolute assertions like "USER_A == 2"
// would otherwise fail on the second run because USER_A still has the
// previous run's balance). The first byte encodes the user's tag (a/b/e)
// and the remaining 19 bytes are derived from `Date.now()`'s hex.
const RUN = Date.now().toString(36);
const runHex = Date.now().toString(16).padStart(38, "0").slice(-38);
const USER_A = `0xa${runHex.slice(0, 38).padEnd(39, "1")}`.slice(0, 42).toLowerCase();
const USER_B = `0xb${runHex.slice(0, 38).padEnd(39, "2")}`.slice(0, 42).toLowerCase();
const USER_E = `0xe${runHex.slice(0, 38).padEnd(39, "3")}`.slice(0, 42).toLowerCase();

// Unique domain prefix per run so re-running doesn't trip the
// "domain already exists, first-publish-only" rule.
const D = (name: string) => `smoke-${RUN}-${name}.dot`;

const FAKE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

// Manually-pumped tx overrides. The runtime's auto-estimator dry-runs at the
// PRIOR-tx state, so a long serial sequence (each tx growing storage) can land
// with too little gas budget and silently revert / OutOfGas. Pinning the
// limits high bypasses the estimator entirely.
//   ref_time: 60s of compute (network max is much higher)
//   proof_size: 5 MB witness
//   storage_deposit_limit: 5 PAS (50_000_000_000 planck) — way more than the
//     ~500 B per publish actually consumes
const TX_OPTS = {
  gasLimit: { ref_time: 1_500_000_000_000n, proof_size: 2_000_000n },
  storageDepositLimit: 1_000_000_000_000n,
  waitFor: "finalized" as const,
} as const;

// ---------------------------------------------------------------------------
// Assertion helpers — print each step inline so partial failures are debuggable.
// ---------------------------------------------------------------------------

let passes = 0;
let fails = 0;

function bigJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

function check<T>(label: string, actual: T, expected: T): void {
  const ok = bigJson(actual) === bigJson(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    fails++;
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${bigJson(expected)}`);
    console.log(`      actual:   ${bigJson(actual)}`);
  }
}

async function expectRevert(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fails++;
    console.log(`  ✗ ${label} — expected revert but call succeeded`);
  } catch (e) {
    passes++;
    console.log(`  ✓ ${label} (reverted as expected)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Smoke test — @staging/playground-registry");
  console.log("------------------------------------------");

  const client = createClient(getWsProvider(ASSET_HUB_WS));
  const { signer, ss58Address: origin } = seedToAccount(DEV_SURI, "");
  const devH160 = deriveH160(signer.publicKey);
  console.log(`DEV signer SS58:  ${origin}`);
  console.log(`DEV signer H160:  ${devH160}`);

  // Patch the ABI from the locally-built artifact so the manager generates a
  // typed handle for every method we exercise (cdm.json's snapshot may be
  // older than the local source while iterating).
  const cdmJson: CdmJson = JSON.parse(JSON.stringify(cdmJsonRaw));
  const localAbi = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "target/playground-registry.release.abi.json"), "utf-8"),
  );
  (cdmJson as any).contracts[PACKAGE].abi = localAbi;

  // Live-resolve the contract address from the on-chain CDM registry. Mirrors
  // the UI's `ContractManager.fromLiveClient` call in src/utils/contracts.ts —
  // a fresh `cdm deploy` is picked up automatically with no manual address
  // bump in the smoke test. Strict-fail: if the registry call rejects, this
  // throws (same trade-off as the UI: stale snapshot + new ABI is worse).
  const manager = await ContractManager.fromLiveClient(
    cdmJson,
    client,
    paseo_asset_hub,
    {
      defaultSigner: signer,
      defaultOrigin: origin,
      registryOrigin: origin,
      libraries: [PACKAGE],
    },
  );
  const reg: any = manager.getContract(PACKAGE);

  console.log(`Contract (live-resolved): ${manager.getAddress(PACKAGE)}`);
  console.log(`reg.setBlacklisted exists: ${!!reg.setBlacklisted}`);
  console.log(`reg.getAppCount exists: ${!!reg.getAppCount}`);
  console.log(`Initial app_count on chain: ${(await reg.getAppCount.query()).value}`);
  console.log(`Initial sudo on chain: ${(await reg.getSudo.query()).value}`);

  // --- Pre-flight: blacklist DEV so it can't grant itself points -----------
  console.log("\n[setup] add DEV to blacklist (sudo)");
  const blResult: any = await reg.setBlacklisted.tx([devH160], true, TX_OPTS);
  console.log(`  tx result ok=${blResult.ok} hash=${blResult.txHash ?? "n/a"}`);
  if (!blResult.ok) throw new Error("setBlacklisted failed");
  check("is_blacklisted(DEV)", (await reg.isBlacklisted.query(devH160)).value, true);
  check("is_blacklisted(USER_A) starts false", (await reg.isBlacklisted.query(USER_A)).value, false);
  check("get_points(DEV) starts at 0", Number((await reg.getPoints.query(devH160)).value), 0);

  // Issue #286 final XP values — sourced from the frontend's single source
  // of truth so drift between the smoke test and the UI is impossible. The
  // contract's `DEPLOY_XP` / `MOD_RECEIVED_XP` / etc. must match these too.
  const DEPLOY_XP = XP_VALUES.deploy;
  const MOD_RECEIVED_XP = XP_VALUES.modReceived;
  const STAR_RECEIVED_XP = XP_VALUES.starReceived;
  const USERNAME_BONUS_XP = XP_VALUES.username;

  // --- Scenario 1: Public publish gives DEPLOY_XP for the owner's 1st app --
  console.log(`\n[scenario 1] public publish → +${DEPLOY_XP} to owner (1st app)`);
  const beforeCount = Number((await reg.getAppCount.query()).value);
  // Dry-run first to surface any revert reason that .tx() may otherwise
  // swallow (e.g. Revive.OutOfGas reported only via dispatch events).
  const dryRun: any = await reg.publish.query(
    D("alpha"), FAKE_CID, VISIBILITY_PUBLIC,
    { isSome: true, value: USER_A }, NO_MODDED_FROM, false, false,
  );
  console.log(`  publish dry-run: success=${dryRun.success} value=${bigJson(dryRun.value)}`);
  if (!dryRun.success) {
    console.log(`  publish would revert — stopping smoke test for diagnosis.`);
    client.destroy();
    process.exit(2);
  }
  const pubResult: any = await reg.publish.tx(D("alpha"), FAKE_CID, VISIBILITY_PUBLIC, { isSome: true, value: USER_A }, NO_MODDED_FROM, false, false, TX_OPTS);
  console.log(`  publish tx ok=${pubResult.ok} hash=${pubResult.txHash ?? "n/a"}`);
  const afterCount = Number((await reg.getAppCount.query()).value);
  console.log(`  app_count: ${beforeCount} -> ${afterCount}`);
  const ownerRes = (await reg.getOwner.query(D("alpha"))).value;
  console.log(`  get_owner("${D("alpha")}") -> ${ownerRes}`);
  check(`get_points(USER_A) == ${DEPLOY_XP}`, Number((await reg.getPoints.query(USER_A)).value), DEPLOY_XP);

  // --- Scenario 2: Moddable bonus is gone (#286 dropped it) ----------------
  console.log(`\n[scenario 2] public + moddable publish → +${DEPLOY_XP} (NO moddable bonus)`);
  await reg.publish.tx(D("beta"), FAKE_CID, VISIBILITY_PUBLIC, { isSome: true, value: USER_B }, NO_MODDED_FROM, true, false, TX_OPTS);
  check(`get_points(USER_B) == ${DEPLOY_XP}`, Number((await reg.getPoints.query(USER_B)).value), DEPLOY_XP);

  // --- Scenario 3: Private publish gives 0 points --------------------------
  console.log("\n[scenario 3] private publish → 0 points (not on playground)");
  // Use a fresh fake address so we can assert exactly 0.
  const USER_X = "0xc000000000000000000000000000000000000099";
  await reg.publish.tx(D("private"), FAKE_CID, VISIBILITY_PRIVATE, { isSome: true, value: USER_X }, NO_MODDED_FROM, false, false, TX_OPTS);
  check("get_points(USER_X) == 0 (private)", Number((await reg.getPoints.query(USER_X)).value), 0);

  // --- Scenario 4: is_dev_signer=true suppresses all awards ----------------
  console.log("\n[scenario 4] is_dev_signer=true → 0 points");
  const USER_Y = "0xc000000000000000000000000000000000000098";
  await reg.publish.tx(D("dev"), FAKE_CID, VISIBILITY_PUBLIC, { isSome: true, value: USER_Y }, NO_MODDED_FROM, true, true, TX_OPTS);
  check("get_points(USER_Y) == 0 (is_dev_signer)", Number((await reg.getPoints.query(USER_Y)).value), 0);

  // --- Scenario 5: Mod publish credits source owner ------------------------
  console.log(`\n[scenario 5] USER_E mods beta → USER_E +${DEPLOY_XP} (1st deploy), USER_B +${MOD_RECEIVED_XP} (mod credit)`);
  await reg.publish.tx(
    D("mod-one"),
    FAKE_CID,
    VISIBILITY_PUBLIC,
    { isSome: true, value: USER_E },
    D("beta"),
    false,
    false,
    TX_OPTS,
  );
  check(`get_points(USER_E) == ${DEPLOY_XP} after first mod`, Number((await reg.getPoints.query(USER_E)).value), DEPLOY_XP);
  check(
    `get_points(USER_B) == ${DEPLOY_XP + MOD_RECEIVED_XP} (deploy + mod credit)`,
    Number((await reg.getPoints.query(USER_B)).value),
    DEPLOY_XP + MOD_RECEIVED_XP,
  );
  check("get_mod_count(beta) == 1", Number((await reg.getModCount.query(D("beta"))).value), 1);

  // --- Scenario 6: Second mod by same modder, NO double credit -------------
  console.log(`\n[scenario 6] USER_E mods beta AGAIN → USER_E +${DEPLOY_XP} (their 2nd deploy); USER_B unchanged (dedupe)`);
  await reg.publish.tx(
    D("mod-two"),
    FAKE_CID,
    VISIBILITY_PUBLIC,
    { isSome: true, value: USER_E },
    D("beta"),
    false,
    false,
    TX_OPTS,
  );
  check(
    `get_points(USER_E) == ${2 * DEPLOY_XP} (two deploys)`,
    Number((await reg.getPoints.query(USER_E)).value),
    2 * DEPLOY_XP,
  );
  check(
    `get_points(USER_B) == ${DEPLOY_XP + MOD_RECEIVED_XP} (no second credit)`,
    Number((await reg.getPoints.query(USER_B)).value),
    DEPLOY_XP + MOD_RECEIVED_XP,
  );
  check("get_mod_count(beta) == 1 (unique-modder count)", Number((await reg.getModCount.query(D("beta"))).value), 1);

  // --- Scenario 7: Leaderboard is sorted descending ------------------------
  console.log("\n[scenario 7] leaderboard ordering");
  const top: any = (await reg.getTopBuilders.query(0, 10)).value;
  console.log(`  raw: ${JSON.stringify(top.map((e: any) => ({ a: e.account, s: Number(e.score) })))}`);
  for (let i = 1; i < top.length; i++) {
    check(
      `top[${i - 1}].score >= top[${i}].score`,
      Number(top[i - 1].score) >= Number(top[i].score),
      true,
    );
  }
  // The page must include both USER_B and USER_E since they have positive
  // scores, and must NOT include DEV (blacklisted) or USER_X/USER_Y (0
  // score, evicted from index).
  const accounts = new Set(top.map((e: any) => (e.account as string).toLowerCase()));
  check("leaderboard includes USER_B", accounts.has(USER_B), true);
  check("leaderboard includes USER_E", accounts.has(USER_E), true);
  check("leaderboard excludes blacklisted DEV", accounts.has(devH160.toLowerCase()), false);
  check("leaderboard excludes zero-score USER_X", accounts.has(USER_X), false);

  // --- Scenario 8: get_point_breakdown ------------------------------------
  // Under #286 the bucket fields are no longer "XP per bucket" — `mod_points`
  // and `star_points` are sums of the per-domain `mod_count` / `star_count`
  // (counts, not XP), and `launch_points` is whatever residual the formula
  // produces. The frontend reads them as counts via `PointsBreakdown.tsx` and
  // reads lifetime deploy count via `get_owner_app_count`.
  console.log("\n[scenario 8] get_point_breakdown — counts + total only");
  const bdB: any = (await reg.getPointBreakdown.query(USER_B)).value;
  check(`USER_B total == ${DEPLOY_XP + MOD_RECEIVED_XP}`, Number(bdB.total), DEPLOY_XP + MOD_RECEIVED_XP);
  check("USER_B mod_points == 1 (mod_count sum)", Number(bdB.mod_points), 1);
  check("USER_B star_points == 0", Number(bdB.star_points), 0);
  check("get_owner_app_count(USER_B) == 1", Number((await reg.getOwnerAppCount.query(USER_B)).value), 1);

  const bdE: any = (await reg.getPointBreakdown.query(USER_E)).value;
  check(`USER_E total == ${2 * DEPLOY_XP}`, Number(bdE.total), 2 * DEPLOY_XP);
  check("USER_E mod_points == 0 (no incoming mods on USER_E apps)", Number(bdE.mod_points), 0);
  check("get_owner_app_count(USER_E) == 2", Number((await reg.getOwnerAppCount.query(USER_E)).value), 2);

  // --- Scenario 9: Self-star is rejected -----------------------------------
  console.log("\n[scenario 9] DEV stars an app owned by DEV → SelfStarForbidden");
  // Publish an app owned by DEV (no owner override).
  await reg.publish.tx(D("self-app"), FAKE_CID, VISIBILITY_PUBLIC, NO_OWNER, NO_MODDED_FROM, false, true, TX_OPTS);
  await expectRevert("star() reverts when caller == owner", async () => {
    await reg.star.tx(D("self-app"), TX_OPTS);
  });

  // --- Scenario 10: Star + unstar — XP is now ONE-WAY (#287) ---------------
  console.log(`\n[scenario 10] DEV stars USER_B's beta → USER_B +${STAR_RECEIVED_XP}, unstar does NOT refund`);
  const beforeStar = Number((await reg.getPoints.query(USER_B)).value);
  await reg.star.tx(D("beta"), TX_OPTS);
  check("get_star_count(beta) == 1", Number((await reg.getStarCount.query(D("beta"))).value), 1);
  check(
    `USER_B +${STAR_RECEIVED_XP} after star`,
    Number((await reg.getPoints.query(USER_B)).value),
    beforeStar + STAR_RECEIVED_XP,
  );
  check("has_starred(DEV, beta) == true", (await reg.hasStarred.query(devH160, D("beta"))).value, true);

  await expectRevert("double-star reverts", async () => {
    await reg.star.tx(D("beta"), TX_OPTS);
  });

  await reg.unstar.tx(D("beta"), TX_OPTS);
  check(
    `USER_B keeps +${STAR_RECEIVED_XP} after unstar (one-way XP)`,
    Number((await reg.getPoints.query(USER_B)).value),
    beforeStar + STAR_RECEIVED_XP,
  );
  check("get_star_count(beta) == 0 (unstar decremented count)", Number((await reg.getStarCount.query(D("beta"))).value), 0);
  check("has_starred(DEV, beta) == false", (await reg.hasStarred.query(devH160, D("beta"))).value, false);

  // --- Scenario 11: Empty metadata_uri reverts -----------------------------
  console.log("\n[scenario 11] empty metadata_uri rejected at publish");
  await expectRevert("publish with empty metadata_uri reverts", async () => {
    await reg.publish.tx(D("empty"), "", VISIBILITY_PUBLIC, NO_OWNER, NO_MODDED_FROM, false, false, TX_OPTS);
  });

  // --- Scenario 12: Unpublish-republish does NOT re-award launch points ----
  // Regression guard for the farming vector: publish → +DEPLOY_XP →
  // unpublish (no refund) → publish again → 0 (launch_awarded persists
  // through unpublish so the second publish skips the launch + mod path).
  console.log("\n[scenario 12] unpublish + republish does NOT re-award launch");
  // USER_F also has to be per-run for the same reason as USER_A/B/E above.
  const USER_F = `0xf${runHex.slice(0, 38).padEnd(39, "4")}`.slice(0, 42).toLowerCase();
  const farmDomain = D("farm");
  await reg.publish.tx(farmDomain, FAKE_CID, VISIBILITY_PUBLIC, { isSome: true, value: USER_F }, NO_MODDED_FROM, true, false, TX_OPTS);
  check(`USER_F == ${DEPLOY_XP} after first publish`, Number((await reg.getPoints.query(USER_F)).value), DEPLOY_XP);
  await reg.unpublish.tx(farmDomain, TX_OPTS);
  check(`USER_F still has ${DEPLOY_XP} after unpublish`, Number((await reg.getPoints.query(USER_F)).value), DEPLOY_XP);
  await reg.publish.tx(farmDomain, FAKE_CID, VISIBILITY_PUBLIC, { isSome: true, value: USER_F }, NO_MODDED_FROM, true, false, TX_OPTS);
  check(`USER_F stays at ${DEPLOY_XP} after republish (launch_awarded blocks)`, Number((await reg.getPoints.query(USER_F)).value), DEPLOY_XP);

  // --- Scenario 13: 3rd+ deploy by the same owner pays 0 (#288 gate) ------
  // Under the new model, only the owner's first two apps pay DEPLOY_XP. The
  // third publish under the same owner still updates indices but credits 0.
  console.log(`\n[scenario 13] USER_E's 3rd deploy → +0 (DEPLOY_REWARD_COUNT gate)`);
  const beforeThird = Number((await reg.getPoints.query(USER_E)).value);
  await reg.publish.tx(
    D("third"),
    FAKE_CID,
    VISIBILITY_PUBLIC,
    { isSome: true, value: USER_E },
    NO_MODDED_FROM,
    false,
    false,
    TX_OPTS,
  );
  check(
    "USER_E unchanged after 3rd deploy (no XP past slot 2)",
    Number((await reg.getPoints.query(USER_E)).value),
    beforeThird,
  );
  check("get_owner_app_count(USER_E) == 3 (index still advances)", Number((await reg.getOwnerAppCount.query(USER_E)).value), 3);

  // --- Scenario 14: set_username flag dedupe under blacklist --------------
  // The smoke test only has DEV as a signer, and DEV is blacklisted so
  // `try_award` no-ops. What we CAN test: the `username_bonus_awarded` flag
  // is set on first call regardless of blacklist, and a later un-blacklist
  // + rename still doesn't pay out the bonus (the flag is sticky). The
  // cross-account `+${USERNAME_BONUS_XP}` happy path needs a multi-signer
  // fixture this script doesn't yet have — TODO at the top of the file.
  console.log(`\n[scenario 14] set_username flag persists across blacklist toggles + renames`);
  const u1 = `dev-${RUN.slice(0, 8)}`.slice(0, 30).toLowerCase();
  const u2 = `${u1}-x`.slice(0, 30).toLowerCase();
  const u3 = `${u1}-y`.slice(0, 30).toLowerCase();
  const beforeUsername = Number((await reg.getPoints.query(devH160)).value);
  await reg.setUsername.tx(u1, TX_OPTS);
  check("DEV unchanged after first set_username (blacklisted)", Number((await reg.getPoints.query(devH160)).value), beforeUsername);
  check("get_username(DEV) == u1", (await reg.getUsername.query(devH160)).value, u1);
  await reg.setUsername.tx(u2, TX_OPTS);
  check("DEV unchanged after rename (still blacklisted)", Number((await reg.getPoints.query(devH160)).value), beforeUsername);
  await reg.setBlacklisted.tx([devH160], false, TX_OPTS);
  await reg.setUsername.tx(u3, TX_OPTS);
  check("DEV unchanged after rename (un-blacklisted, flag already set)", Number((await reg.getPoints.query(devH160)).value), beforeUsername);
  // Restore blacklist for any downstream scenarios.
  await reg.setBlacklisted.tx([devH160], true, TX_OPTS);
  void USERNAME_BONUS_XP; // referenced in comment, kept imported for the happy-path TODO

  // --- Wrap up -------------------------------------------------------------
  console.log(`\n------------------------------------------`);
  console.log(`Smoke test: ${passes} passed, ${fails} failed`);
  client.destroy();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});
