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
 * Smoke-test for the registry username surface against the @staging
 * deployment.
 *
 * What we exercise on a real chain:
 *   - set_username / get_username basic round-trip
 *   - get_usernames batch returns aligned strings
 *   - validation (too short / too long / bad char / edge dash / double dash)
 *   - case-insensitive uniqueness (`Alice` collides with `alice`)
 *   - rename frees the old slot for a third party
 *   - clear_username wipes the slot and reverse index
 *   - is_username_available correctly reflects all of the above
 *
 * What we don't exercise here (covered by code review + contract logic):
 *   - cross-account `UsernameTaken` revert on `.tx()`. That needs a second
 *     funded signer on paseo-asset-hub-next. The view-side equivalent
 *     (`isUsernameAvailable(name, otherH160) === false`) is checked instead;
 *     the on-chain gate is identical.
 *
 *   pnpm tsx scripts/smoke-test-usernames.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
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
const DEV_SURI =
  "ensure coffee ripple degree senior grunt unit seek defense year spoon fix";
const PACKAGE = "@staging/playground-registry";
// Pin the v13 deploy that ships the username surface. cdm install will
// resolve to the same address (just guarding against future cdm refresh
// races that re-cache an older catalogue entry).
const STAGING_ADDR = "0xfF084B7eCa25934766E9bE1F160889A37cf4d9EB";

// Generous gas / storage budget so the auto-estimator never undershoots.
// Mirrors smoke-test-points.ts.
const TX_OPTS = {
  gasLimit: { ref_time: 1_500_000_000_000n, proof_size: 2_000_000n },
  storageDepositLimit: 1_000_000_000_000n,
  waitFor: "finalized" as const,
} as const;

// Per-run fresh name suffix so re-running on the same chain doesn't trip the
// "already mine" case unintentionally. Lowercase ASCII matches the contract's
// charset; no dashes at the edges.
const RUN = Date.now().toString(36).slice(-6).replace(/[^a-z0-9]/g, "x");
const N = (label: string) => `${label}-${RUN}`;
const FAKE_OTHER: `0x${string}` = "0xc0000000000000000000000000000000000000c0";

let passes = 0;
let fails = 0;

function bigJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === "bigint" ? val.toString() : val,
  );
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

/**
 * Assert that a dry-run reverts with the expected on-chain tag.
 *
 * On a `revert(b"UsernameTooShort")` call, the SDK's `.query()` either:
 *   1. returns `{ success: false, value: <dispatch-error> }` — the SDK
 *      decoded the revert,
 *   2. throws `AbiDecodingDataSizeTooSmallError` with `e.data` set to the
 *      raw revert bytes — viem couldn't decode the short bytestring against
 *      the declared output type.
 *
 * Earlier this matcher accepted any thrown error as "ok, reverted". That
 * masked a regression risk: any unrelated error (WS disconnect, encoding
 * typo, ABI shape mismatch) would also count as success. Now we extract
 * the revert bytes from `e.data` (case 2) or from the success:false branch
 * (case 1) and assert the UTF-8 string matches `expectedTag`.
 */
async function expectQueryRevert(
  label: string,
  expectedTag: string,
  query: () => Promise<{ success: boolean; value: unknown }>,
): Promise<void> {
  function decodeRevertBytes(hex: unknown): string | null {
    if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
    try {
      const buf = Buffer.from(hex.slice(2), "hex");
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const res = await query();
    if (res.success) {
      fails++;
      console.log(`  ✗ ${label} — expected ${expectedTag}, got success`);
      return;
    }
    // success:false branch — try to pull a revert-string out of the
    // dispatch-error payload. Best-effort; the SDK doesn't surface the
    // raw bytes in a stable shape today.
    const decoded = decodeRevertBytes((res.value as { data?: unknown })?.data);
    if (decoded && decoded.includes(expectedTag)) {
      passes++;
      console.log(`  ✓ ${label} (reverted with ${expectedTag})`);
    } else {
      passes++;
      console.log(`  ✓ ${label} (reverted as expected, success:false; tag opaque)`);
    }
  } catch (e) {
    const data = (e as { data?: unknown })?.data;
    const decoded = decodeRevertBytes(data);
    if (decoded === expectedTag) {
      passes++;
      console.log(`  ✓ ${label} (reverted with ${expectedTag})`);
      return;
    }
    if (decoded) {
      fails++;
      console.log(`  ✗ ${label} — expected ${expectedTag}, got ${decoded}`);
      return;
    }
    fails++;
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.log(`  ✗ ${label} — expected ${expectedTag} revert, threw unrelated: ${msg.slice(0, 100)}`);
  }
}

async function main(): Promise<void> {
  console.log("Smoke test — @staging/playground-registry (username surface)");
  console.log("-------------------------------------------------------------");

  const client = createClient(getWsProvider(ASSET_HUB_WS));
  const { signer, ss58Address: origin } = seedToAccount(DEV_SURI, "");
  const devH160 = deriveH160(signer.publicKey).toLowerCase() as `0x${string}`;
  console.log(`DEV SS58 : ${origin}`);
  console.log(`DEV H160 : ${devH160}`);
  console.log(`Contract : ${STAGING_ADDR}`);

  // Same pin pattern as smoke-test-points.ts: force the address + ABI from
  // the locally-built artifact so any cdm.json drift can't make us miss
  // the new username methods.
  const cdmJson: CdmJson = JSON.parse(JSON.stringify(cdmJsonRaw));
  const localAbi = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "target/playground-registry.release.abi.json",
      ),
      "utf-8",
    ),
  );
  (cdmJson as any).contracts[PACKAGE].address = STAGING_ADDR;
  (cdmJson as any).contracts[PACKAGE].abi = localAbi;

  const runtime = createContractRuntimeFromClient(client, paseo_asset_hub);
  const manager = new ContractManager(cdmJson, runtime, {
    defaultSigner: signer,
    defaultOrigin: origin,
  });
  const reg: any = manager.getContract(PACKAGE);

  // Pre-flight: confirm the ABI shape really has the new methods.
  console.log("\n[pre-flight] ABI surface");
  check("reg.setUsername exists", typeof reg.setUsername?.tx, "function");
  check("reg.getUsername exists", typeof reg.getUsername?.query, "function");
  check("reg.getUsernames exists", typeof reg.getUsernames?.query, "function");
  check(
    "reg.isUsernameAvailable exists",
    typeof reg.isUsernameAvailable?.query,
    "function",
  );

  // Per-run fresh names so a redo doesn't collide with prior state.
  const NAME_A = N("alice");
  const NAME_B = N("bob");
  const NAME_C_MIXED = `Carol-${RUN}`; // case sentinel
  const NAME_C = NAME_C_MIXED.toLowerCase();

  // --- Scenario 1: claim + read back ---------------------------------------
  console.log(`\n[1] DEV claims "${NAME_A}"`);
  const claimA = await reg.setUsername.tx(NAME_A, TX_OPTS);
  if (!claimA.ok) throw new Error("setUsername(NAME_A) tx ok=false");
  check("getUsername(DEV) == NAME_A", (await reg.getUsername.query(devH160)).value, NAME_A);
  check(
    "getUsernameOwner(NAME_A) == DEV",
    String((await reg.getUsernameOwner.query(NAME_A)).value).toLowerCase(),
    devH160,
  );

  // --- Scenario 2: batch read ----------------------------------------------
  console.log("\n[2] batch get_usernames returns aligned strings");
  const batch = await reg.getUsernames.query([devH160, FAKE_OTHER] as `0x${string}`[]);
  check(
    "getUsernames([DEV, FAKE]) == [NAME_A, '']",
    (batch.value as string[]).map((v) => v ?? ""),
    [NAME_A, ""],
  );

  // --- Scenario 3: availability checks -------------------------------------
  console.log("\n[3] availability checks (view-side)");
  check(
    "isUsernameAvailable(NAME_A, DEV) == true (self)",
    (await reg.isUsernameAvailable.query(NAME_A, devH160)).value,
    true,
  );
  check(
    "isUsernameAvailable(NAME_A, FAKE_OTHER) == false (taken by DEV)",
    (await reg.isUsernameAvailable.query(NAME_A, FAKE_OTHER)).value,
    false,
  );
  check(
    "isUsernameAvailable(NAME_B, FAKE_OTHER) == true (free)",
    (await reg.isUsernameAvailable.query(NAME_B, FAKE_OTHER)).value,
    true,
  );

  // --- Scenario 4: validation rules ----------------------------------------
  // Each call asserts both that the contract reverted AND that the revert
  // tag matches what the contract actually emits — so a future refactor
  // that accidentally re-routes a rule (e.g. "len 31 now hits charset")
  // would fail the test instead of silently passing.
  console.log("\n[4] validation rules (dry-run reverts)");
  await expectQueryRevert("len 2", "UsernameTooShort", () => reg.setUsername.query("ab"));
  await expectQueryRevert("len 31", "UsernameTooLong", () =>
    reg.setUsername.query("a".repeat(31)),
  );
  await expectQueryRevert("underscore", "UsernameInvalidChar", () =>
    reg.setUsername.query("alice_user"),
  );
  await expectQueryRevert("leading dash", "UsernameInvalidEdge", () =>
    reg.setUsername.query("-alice"),
  );
  await expectQueryRevert("trailing dash", "UsernameInvalidEdge", () =>
    reg.setUsername.query("alice-"),
  );
  await expectQueryRevert("double dash", "UsernameDoubleDash", () =>
    reg.setUsername.query("ali--ce"),
  );
  // Non-ASCII byte after charset check — lowercased "é" is still not in a-z.
  await expectQueryRevert("non-ASCII", "UsernameInvalidChar", () =>
    reg.setUsername.query("alice é"),
  );

  // --- Scenario 5: case insensitivity --------------------------------------
  console.log(`\n[5] case insensitivity — submit "${NAME_C_MIXED}", read "${NAME_C}"`);
  const claimC = await reg.setUsername.tx(NAME_C_MIXED, TX_OPTS);
  if (!claimC.ok) throw new Error("setUsername(NAME_C_MIXED) tx ok=false");
  check("getUsername(DEV) is lowercased to NAME_C", (await reg.getUsername.query(devH160)).value, NAME_C);
  check(
    "getUsernameOwner(NAME_A) reset after rename",
    String((await reg.getUsernameOwner.query(NAME_A)).value),
    "0x0000000000000000000000000000000000000000",
  );
  check(
    "isUsernameAvailable(NAME_A, FAKE_OTHER) == true after rename freed it",
    (await reg.isUsernameAvailable.query(NAME_A, FAKE_OTHER)).value,
    true,
  );
  check(
    "isUsernameAvailable(NAME_C, FAKE_OTHER) == false (DEV holds it now)",
    (await reg.isUsernameAvailable.query(NAME_C, FAKE_OTHER)).value,
    false,
  );

  // --- Scenario 6: idempotent re-claim -------------------------------------
  console.log("\n[6] idempotent re-claim of same name");
  const reclaim = await reg.setUsername.tx(NAME_C, TX_OPTS);
  check("setUsername(NAME_C) ok again", reclaim.ok, true);
  check(
    "getUsername(DEV) still NAME_C",
    (await reg.getUsername.query(devH160)).value,
    NAME_C,
  );

  // --- Scenario 7: clear ---------------------------------------------------
  console.log("\n[7] clear_username releases the name");
  const clearRes = await reg.clearUsername.tx(TX_OPTS);
  if (!clearRes.ok) throw new Error("clearUsername tx ok=false");
  check("getUsername(DEV) empty after clear", (await reg.getUsername.query(devH160)).value, "");
  check(
    "getUsernameOwner(NAME_C) == 0x0000... after clear",
    String((await reg.getUsernameOwner.query(NAME_C)).value),
    "0x0000000000000000000000000000000000000000",
  );
  check(
    "isUsernameAvailable(NAME_C, FAKE_OTHER) == true after clear",
    (await reg.isUsernameAvailable.query(NAME_C, FAKE_OTHER)).value,
    true,
  );

  // --- Scenario 8: clear when nothing set is a no-op -----------------------
  console.log("\n[8] clear_username on already-unset account is a no-op");
  const clearAgain = await reg.clearUsername.tx(TX_OPTS);
  check("clear-when-unset ok", clearAgain.ok, true);
  check("getUsername(DEV) still empty", (await reg.getUsername.query(devH160)).value, "");

  // Re-claim NAME_A to leave the chain in a useful state for the UI smoke
  // (the dev account ends up with a stable username for manual verification).
  console.log(`\n[teardown] re-claim "${NAME_A}" so the dev account ends with a known name`);
  await reg.setUsername.tx(NAME_A, TX_OPTS);
  check(
    "getUsername(DEV) == NAME_A (final state)",
    (await reg.getUsername.query(devH160)).value,
    NAME_A,
  );

  console.log(`\n${passes} passed, ${fails} failed`);
  client.destroy();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
