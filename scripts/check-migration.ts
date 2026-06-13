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
 * Verifies the v14 @staging/playground-registry deployment:
 *   - Lineage recording via publish (forward edge)
 *   - Re-publish deduplication
 *   - importLineage idempotency
 *   - importPoints authoritative SET semantics
 *   - importSocialCounts correctness and ghost-domain safety
 *   - importUsernames correctness
 *   - Non-sudo cannot call any import method (CRITICAL)
 *
 *   pnpm tsx scripts/check-migration.ts
 */

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import {
  ContractManager,
  createContractRuntimeFromClient,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { deriveH160 } from "@parity/product-sdk-address";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import cdmJsonRaw from "../cdm.json" with { type: "json" };

const ASSET_HUB_WS =
  process.env.ASSET_HUB_WS_URL ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_SURI = "ensure coffee ripple degree senior grunt unit seek defense year spoon fix";
const PACKAGE = "@staging/playground-registry";
// v14 address — matches cdm.json but we pin explicitly so re-runs against a
// bumped cdm.json always target the contract under test.
const STAGING_ADDR = "0xc52BcE6B5C8533E3C871053A54Da2eC7084a4438";

const VISIBILITY_PUBLIC = 1;
const NO_OWNER = { isSome: false, value: "0x0000000000000000000000000000000000000000" } as const;
const FAKE_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

// Unique suffix so every re-run uses fresh domain/name strings.
const RUN = Date.now().toString(36);
const D = (name: string) => `mig-${RUN}-${name}.dot`;

// Per-tx overrides: pinned gas/storage to avoid auto-estimator underruns on a
// fresh (empty) staging contract. Values match smoke-test-points.ts + import-registry-state.ts.
const TX_OPTS = {
  gasLimit: { ref_time: 1_500_000_000_000n, proof_size: 2_000_000n },
  storageDepositLimit: 1_000_000_000_000n,
  waitFor: "finalized" as const,
} as const;

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passes = 0;
let fails = 0;

function bigJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

function pass(label: string): void {
  passes++;
  console.log(`  PASS ${label}`);
}

function fail(label: string, detail?: string): void {
  fails++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  // Exit immediately on first failure.
  console.log("\nFirst FAIL encountered — aborting.");
  process.exit(1);
}

function check<T>(label: string, actual: T, expected: T): void {
  if (bigJson(actual) === bigJson(expected)) {
    pass(label);
  } else {
    fail(label, `expected ${bigJson(expected)}, got ${bigJson(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Migration check — @staging/playground-registry v14");
  console.log("====================================================");
  console.log(`RUN suffix: ${RUN}`);

  const client = createClient(getWsProvider(ASSET_HUB_WS));

  // Sudo signer
  const { signer, ss58Address: origin } = seedToAccount(DEV_SURI, "");
  const devH160 = deriveH160(signer.publicKey);
  console.log(`Sudo SS58:  ${origin}`);
  console.log(`Sudo H160:  ${devH160}`);

  // (No non-sudo signer needed — [7] uses a free dry-run query instead of a tx)
  console.log(`Contract:   ${STAGING_ADDR}`);

  // Patch cdm.json to ensure we target v14 even if cdm.json is updated later.
  const cdmJson: CdmJson = JSON.parse(JSON.stringify(cdmJsonRaw));
  (cdmJson as any).contracts[PACKAGE].address = STAGING_ADDR;

  const runtime = createContractRuntimeFromClient(client, paseo_asset_hub);
  const manager = new ContractManager(cdmJson, runtime, {
    defaultSigner: signer,
    defaultOrigin: origin,
  });
  const reg: any = manager.getContract(PACKAGE);

  console.log(`Resolved address: ${manager.getAddress(PACKAGE)}`);
  const initialCount = Number((await reg.getAppCount.query()).value);
  console.log(`Initial getAppCount: ${initialCount}`);
  const initialLineageCount = Number((await reg.getLineageCount.query()).value);
  console.log(`Initial getLineageCount: ${initialLineageCount}`);
  console.log();

  // =========================================================================
  // Assertion 1: Forward lineage recorded inside publish
  // =========================================================================
  console.log("[1] Forward lineage via publish");

  // Publish source (no modded_from)
  const srcDomain = D("src");
  const srcPub: any = await reg.publish.tx(
    srcDomain, FAKE_CID, VISIBILITY_PUBLIC, NO_OWNER, "", false, true, TX_OPTS,
  );
  if (!srcPub.ok) fail("publish src domain", `tx ok=false hash=${srcPub.txHash}`);

  // Publish child (modded_from = srcDomain, isDevSigner=true so XP gating doesn't interfere)
  const childDomain = D("child");
  const childPub: any = await reg.publish.tx(
    childDomain, FAKE_CID, VISIBILITY_PUBLIC, NO_OWNER, srcDomain, false, true, TX_OPTS,
  );
  if (!childPub.ok) fail("publish child domain", `tx ok=false hash=${childPub.txHash}`);

  const lineageCountAfterPublish = Number((await reg.getLineageCount.query()).value);
  console.log(`  getLineageCount after publish: ${lineageCountAfterPublish}`);
  // Should have grown by at least 1 (may have pre-existing entries if contract is not truly empty)
  check("lineageCount increased by 1 after publish", lineageCountAfterPublish, initialLineageCount + 1);

  // Page the full lineage list and find our edge
  const lineageRes: any = await reg.getLineage.query(0, lineageCountAfterPublish);
  const lineageEntries: Array<{ child: string; source: string }> = lineageRes.value ?? [];
  const edge = lineageEntries.find(
    (e) => e.child === childDomain && e.source === srcDomain,
  );
  check(
    `edge child=${childDomain} source=${srcDomain} exists`,
    edge !== undefined,
    true,
  );

  // =========================================================================
  // Assertion 2: Re-publish does NOT duplicate the edge
  // =========================================================================
  console.log("\n[2] Re-publish deduplication");

  const rePub: any = await reg.publish.tx(
    childDomain, FAKE_CID, VISIBILITY_PUBLIC, NO_OWNER, srcDomain, false, true, TX_OPTS,
  );
  if (!rePub.ok) fail("re-publish child domain", `tx ok=false hash=${rePub.txHash}`);

  const lineageCountAfterRepublish = Number((await reg.getLineageCount.query()).value);
  check(
    "lineageCount unchanged after re-publish",
    lineageCountAfterRepublish,
    lineageCountAfterPublish,
  );

  // Also assert that exactly ONE edge matching (child, source) exists — a
  // "replace-with-duplicate" bug would keep the count flat but this catches it.
  const lineageAfterRepub: any = await reg.getLineage.query(0, lineageCountAfterRepublish);
  const edgesAfterRepub: Array<{ child: string; source: string }> = lineageAfterRepub.value ?? [];
  const matchingEdges = edgesAfterRepub.filter(
    (e) => e.child === childDomain && e.source === srcDomain,
  );
  check(
    `exactly 1 edge child=${childDomain} source=${srcDomain} after re-publish (no duplicate)`,
    matchingEdges.length,
    1,
  );

  // =========================================================================
  // Assertion 3: importLineage is idempotent
  // =========================================================================
  console.log("\n[3] importLineage idempotency");

  const impChild = `imp-c-${RUN}.dot`;
  const impSource = `imp-s-${RUN}.dot`;
  const importEntry = [{ child: impChild, source: impSource }];

  const beforeImport = Number((await reg.getLineageCount.query()).value);

  // First call
  const imp1: any = await reg.importLineage.tx(importEntry, TX_OPTS);
  if (!imp1.ok) fail("importLineage first call", `tx ok=false hash=${imp1.txHash}`);

  const afterImport1 = Number((await reg.getLineageCount.query()).value);
  check("lineageCount +1 after first importLineage", afterImport1, beforeImport + 1);

  // Second call (idempotent — same entry)
  const imp2: any = await reg.importLineage.tx(importEntry, TX_OPTS);
  if (!imp2.ok) fail("importLineage second call", `tx ok=false hash=${imp2.txHash}`);

  const afterImport2 = Number((await reg.getLineageCount.query()).value);
  check("lineageCount unchanged after second importLineage (idempotent)", afterImport2, afterImport1);

  // Verify the edge is present
  const lineageAfterImport: any = await reg.getLineage.query(0, afterImport2);
  const importedEdges: Array<{ child: string; source: string }> = lineageAfterImport.value ?? [];
  const impEdge = importedEdges.find((e) => e.child === impChild && e.source === impSource);
  check(`importLineage edge child=${impChild} source=${impSource} present`, impEdge !== undefined, true);

  // =========================================================================
  // Assertion 4: importPoints is authoritative (SET, not add)
  // =========================================================================
  console.log("\n[4] importPoints SET semantics");

  // per-run unique H160 (valid hex; avoids stale balances from earlier runs)
  const TARGET_ACCT = ("0x" + Date.now().toString(16).padStart(40, "0").slice(-40)) as `0x${string}`;
  console.log(`  TARGET_ACCT (per-run unique): ${TARGET_ACCT}`);

  // Assert zero baseline before any import
  const pts0 = await reg.getPoints.query(TARGET_ACCT);
  check("getPoints(TARGET_ACCT) baseline === 0", pts0.success ? BigInt(pts0.value) : -1n, 0n);

  // Set to 123
  const ip1: any = await reg.importPoints.tx(
    [{ account: TARGET_ACCT, total: 123n }],
    TX_OPTS,
  );
  if (!ip1.ok) fail("importPoints set 123", `tx ok=false hash=${ip1.txHash}`);

  const pts123 = (await reg.getPoints.query(TARGET_ACCT)).value;
  check("getPoints(TARGET_ACCT) === 123", pts123, 123n);

  // Check leaderboard contains TARGET_ACCT with score 123
  // Use page size 200 to ensure a freshly-inserted score-123 entry is found
  // even when there are many other entries on the leaderboard.
  const topBuilders: any = (await reg.getTopBuilders.query(0, 200)).value ?? [];
  const tbEntry = topBuilders.find(
    (e: any) => (e.account as string).toLowerCase() === TARGET_ACCT.toLowerCase(),
  );
  check("TARGET_ACCT appears in getTopBuilders", tbEntry !== undefined, true);
  if (tbEntry) {
    check("TARGET_ACCT leaderboard score === 123", tbEntry.score, 123n);
  }

  // Overwrite to 7 (should replace 123, not add)
  const ip2: any = await reg.importPoints.tx(
    [{ account: TARGET_ACCT, total: 7n }],
    TX_OPTS,
  );
  if (!ip2.ok) fail("importPoints overwrite 7", `tx ok=false hash=${ip2.txHash}`);

  const pts7 = (await reg.getPoints.query(TARGET_ACCT)).value;
  check("getPoints(TARGET_ACCT) === 7 (overwrite, not 130)", pts7, 7n);

  // =========================================================================
  // Assertion 5: importSocialCounts
  // =========================================================================
  console.log("\n[5] importSocialCounts");

  // srcDomain already published — import social counts for it
  const sc1: any = await reg.importSocialCounts.tx(
    [{ domain: srcDomain, star_count: 5, mod_count: 2 }],
    TX_OPTS,
  );
  if (!sc1.ok) fail("importSocialCounts for srcDomain", `tx ok=false hash=${sc1.txHash}`);

  const starCount = Number((await reg.getStarCount.query(srcDomain)).value);
  const modCount = Number((await reg.getModCount.query(srcDomain)).value);
  check(`getStarCount(${srcDomain}) === 5`, starCount, 5);
  check(`getModCount(${srcDomain}) === 2`, modCount, 2);

  // Ghost domain (does not exist) — should NOT revert, silently skip
  const ghostDomain = `ghost-${RUN}.dot`;
  let ghostOk = false;
  try {
    const sc2: any = await reg.importSocialCounts.tx(
      [{ domain: ghostDomain, star_count: 3, mod_count: 1 }],
      TX_OPTS,
    );
    // tx completed (ok=true or ok=false both count as "did not throw")
    ghostOk = true;
    if (sc2.ok) {
      pass("importSocialCounts ghost domain does not revert (ok=true)");
    } else {
      // ok=false means the tx was included but the contract reverted — treat as revert
      fail("importSocialCounts ghost domain reverted (ok=false)");
    }
  } catch (_e) {
    fail("importSocialCounts ghost domain threw an exception (expected silent skip)");
  }

  // Ghost domain counters must remain 0 (import passed both star_count and mod_count;
  // prove BOTH were skipped — not just the star)
  const ghostStar = Number((await reg.getStarCount.query(ghostDomain)).value);
  check(`getStarCount(${ghostDomain}) === 0 (ghost domain, silently skipped)`, ghostStar, 0);
  const ghostMod = Number((await reg.getModCount.query(ghostDomain)).value);
  check(`getModCount(${ghostDomain}) === 0 (ghost domain, silently skipped)`, ghostMod, 0);

  // =========================================================================
  // Assertion 6: importUsernames
  // =========================================================================
  console.log("\n[6] importUsernames");

  // Use TARGET_ACCT again; name must be unique across runs
  const importedName = `checkname${RUN}`;
  const iu1: any = await reg.importUsernames.tx(
    [{ account: TARGET_ACCT, name: importedName }],
    TX_OPTS,
  );
  if (!iu1.ok) fail("importUsernames", `tx ok=false hash=${iu1.txHash}`);

  const storedName: string = (await reg.getUsername.query(TARGET_ACCT)).value ?? "";
  check("getUsername(TARGET_ACCT) === importedName", storedName, importedName);

  const nameOwner: string = ((await reg.getUsernameOwner.query(importedName)).value ?? "").toLowerCase();
  check(
    "getUsernameOwner(importedName) === TARGET_ACCT (case-insensitive)",
    nameOwner,
    TARGET_ACCT.toLowerCase(),
  );

  // =========================================================================
  // Assertion 7: Non-sudo cannot call any import method — verified via
  // contract-level require_sudo() revert using a free dry-run query.
  //
  // Using a tx from an unfunded non-sudo account would be rejected at the
  // payment/transaction-validity layer BEFORE reaching the contract guard,
  // which is not an acceptable proof of access control. Instead we issue a
  // dry-run query from a well-known non-sudo SS58 origin (Alice) — no signer
  // or funds needed. The contract's require_sudo() must revert (success:false
  // or throw) for EACH import method.
  // =========================================================================
  console.log("\n[7] Non-sudo access control — contract-level require_sudo() revert (CRITICAL)");

  // Alice: definitely NOT the sudo account (which is the dev-SURI H160).
  const NON_SUDO_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const DRY_RUN_OPTS = { origin: NON_SUDO_SS58 } as const;

  // Helper: assert a dry-run query reverts (success:false or throws a recognisable
  // contract-revert error). A success:true result means the contract let a non-sudo
  // caller through — hard FAIL. A thrown error that does NOT look like a contract
  // revert (e.g. WebSocket/transport/TypeError) is also a FAIL: it means we never
  // reached the contract guard and cannot prove access control works.
  //
  // Recognised contract-revert error shapes:
  //   • error name/message contains AbiErrorSignatureNotFound
  //   • error name/message contains ContractReverted
  //   • error name/message contains Reverted
  //   • error name/message contains Unauthorized
  //   • error message contains the raw bytes 0x556e6175  ("Unau…" in hex — the
  //     bytes the contract emits for its "Unauthorized" revert message)
  const CONTRACT_REVERT_PATTERNS = [
    "AbiErrorSignatureNotFound",
    "ContractReverted",
    "Reverted",
    "Unauthorized",
    "0x556e6175",
  ] as const;

  function isContractRevertError(e: any): boolean {
    const haystack = ((e?.name ?? "") + " " + (e?.message ?? "") + " " + String(e)).toLowerCase();
    return CONTRACT_REVERT_PATTERNS.some((p) => haystack.includes(p.toLowerCase()));
  }

  async function assertQueryReverts(label: string, fn: () => Promise<any>): Promise<void> {
    try {
      const result = await fn();
      if (result && result.success === false) {
        // Live expected path: contract reverted, SDK returned success:false.
        const reason = result.value !== undefined ? ` revert=${bigJson(result.value)}` : "";
        console.log(`    (contract reverted for non-sudo origin${reason})`);
        pass(`${label}: require_sudo() reverted (success=false)`);
      } else {
        // success:true (or no success field) → guard missing.
        fail(`${label}: dry-run SUCCEEDED for non-sudo origin — require_sudo() guard missing`);
      }
    } catch (e: any) {
      const msg = (e?.message ?? String(e));
      if (isContractRevertError(e)) {
        // Recognisable contract-revert decode error (e.g. AbiErrorSignatureNotFound
        // on the raw "Unauthorized" bytes from the contract).
        console.log(`    (dry-run threw contract-revert error: ${msg.slice(0, 120)})`);
        pass(`${label}: require_sudo() reverted (threw contract-revert error)`);
      } else {
        // Transport/SDK/TypeError — never reached the contract; cannot prove the guard.
        console.log(`    (dry-run threw NON-revert error: ${msg.slice(0, 200)})`);
        fail(`${label}: dry-run threw a transport/SDK error — contract guard not proven`);
      }
    }
  }

  await assertQueryReverts("importLineage by non-sudo dry-run", () =>
    reg.importLineage.query(
      [{ child: `ns-child-${RUN}.dot`, source: `ns-src-${RUN}.dot` }],
      DRY_RUN_OPTS,
    ),
  );

  await assertQueryReverts("importPoints by non-sudo dry-run", () =>
    reg.importPoints.query(
      [{ account: TARGET_ACCT, total: 999n }],
      DRY_RUN_OPTS,
    ),
  );

  await assertQueryReverts("importSocialCounts by non-sudo dry-run", () =>
    reg.importSocialCounts.query(
      [{ domain: srcDomain, star_count: 99, mod_count: 99 }],
      DRY_RUN_OPTS,
    ),
  );

  await assertQueryReverts("importUsernames by non-sudo dry-run", () =>
    reg.importUsernames.query(
      [{ account: TARGET_ACCT, name: `nsname${RUN}` }],
      DRY_RUN_OPTS,
    ),
  );

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n====================================================");
  console.log(`Results: ${passes} passed, ${fails} failed`);

  client.destroy();

  if (fails === 0) {
    console.log("ALL MIGRATION CHECKS PASSED");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("check-migration crashed:", err);
  process.exit(2);
});
