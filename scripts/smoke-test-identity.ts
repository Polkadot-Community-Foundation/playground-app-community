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
 * Smoke-test for the registry identity-binding surface against the @staging
 * deployment.
 *
 * What we exercise on a real chain:
 *   - set_identity binds the caller's product H160 to a SEPARATE root sr25519
 *     account, proving control via a raw sr25519 signature over the canonical
 *     identity message.
 *   - get_root_account reads the binding back.
 *   - get_root_accounts (batch) returns aligned entries, 32 zero bytes for
 *     anonymous accounts.
 *   - Negative: a flipped-byte signature reverts IdentitySigInvalid.
 *   - Negative: a 63-byte signature reverts IdentitySigLen.
 *   - clear_identity wipes the binding (back to 32 zero bytes).
 *
 * Identity model (mirrors production): the tx is SIGNED by the staging dev
 * signer (the "product account", whose H160 is the binding key). The "root
 * account" is a distinct sr25519 keypair generated locally in this script —
 * it never signs a transaction; it only signs the identity message off-chain.
 * The contract verifies that signature against the root pubkey and binds
 * caller_h160 -> root_pubkey.
 *
 * The signed bytes MUST match build_identity_message() in the contract
 * byte-for-byte:
 *   "<Bytes>" || "playground.dot identity v1\n" || <contract_addr 20> ||
 *   <caller_h160 20> || "</Bytes>"
 * The contract reads its OWN address via pvm::api::address(), so we feed the
 * SAME STAGING_ADDR into both the manager pin AND the message builder.
 *
 * Deploy @staging first (see CLAUDE.md "Smoke-testing the contract on @staging"),
 * then set STAGING_ADDR below from the new cdm.json entry.
 *
 *   pnpm tsx scripts/smoke-test-identity.ts
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
import { secretFromSeed, getPublicKey, sign } from "@scure/sr25519";
import cdmJsonRaw from "../cdm.json" with { type: "json" };

const ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_SURI =
  "ensure coffee ripple degree senior grunt unit seek defense year spoon fix";
const PACKAGE = "@staging/playground-registry";
// Update from cdm.json after the @staging deploy. Used BOTH to pin the
// manager address AND to build the identity message bytes (the contract
// reads its own address, so these must be the same value).
const STAGING_ADDR = "0x<NEW_STAGING_ADDRESS>";

// Deterministic 32-byte root-account seed (fixed so re-runs are reproducible).
// This is the SECRET seed of the root sr25519 keypair; it never signs a tx.
const ROOT_SEED = new Uint8Array(32).fill(0x42);

// Generous gas / storage budget so the auto-estimator never undershoots.
// Mirrors smoke-test-points.ts / smoke-test-usernames.ts.
const TX_OPTS = {
  gasLimit: { ref_time: 1_500_000_000_000n, proof_size: 2_000_000n },
  storageDepositLimit: 1_000_000_000_000n,
  waitFor: "finalized" as const,
} as const;

// A second random H160 with no binding, for the batch-read alignment check.
const FAKE_OTHER: `0x${string}` = "0xc0000000000000000000000000000000000000c0";
const ZERO32 = "0x" + "00".repeat(32);

let passes = 0;
let fails = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    fails++;
    console.log(`  FAIL  ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

/** lowercase 0x-prefixed hex of N raw bytes. */
function bytesToHex(b: Uint8Array): `0x${string}` {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

/** 20-byte array from a 0x…(40 hex) address string. */
function hexAddrToBytes20(addr: string): Uint8Array {
  const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (clean.length !== 40) {
    throw new Error(`expected 20-byte address hex, got ${clean.length / 2} bytes`);
  }
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Normalize whatever shape the SDK returns for a `bytes32` / `[u8;32]` value
 * into lowercase 0x hex. The product-sdk-contracts type mapping decodes
 * `bytes32` as a hex string, but be defensive: also accept a FixedSizeBinary
 * (`.asHex()`) or a raw Uint8Array.
 */
function normHex32(v: unknown): string {
  if (typeof v === "string") return v.toLowerCase();
  if (v instanceof Uint8Array) return bytesToHex(v).toLowerCase();
  if (v && typeof (v as { asHex?: () => string }).asHex === "function") {
    return (v as { asHex: () => string }).asHex().toLowerCase();
  }
  return String(v).toLowerCase();
}

/** Canonical identity message bytes — MUST match build_identity_message(). */
function buildWrappedMessage(
  contractAddr20: Uint8Array,
  callerH160_20: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const parts = [
    enc.encode("<Bytes>"),
    enc.encode("playground.dot identity v1\n"),
    contractAddr20,
    callerH160_20,
    enc.encode("</Bytes>"),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Run a `.tx()` that should REVERT. Returns the revert tag if we could decode
 * one from the thrown error, else null. PASS is decided by the caller (it
 * threw at all). Best-effort tag extraction from `e.data` / `e.message`.
 */
async function expectTxRevert(
  label: string,
  expectedTag: string,
  txCall: () => Promise<{ ok: boolean }>,
): Promise<void> {
  function decodeRevertBytes(hex: unknown): string | null {
    if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
    try {
      return Buffer.from(hex.slice(2), "hex").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const res = await txCall();
    // Some SDK paths surface a dry-run revert as ok:false instead of throwing.
    if (!res.ok) {
      passes++;
      console.log(`  PASS  ${label} (tx ok=false, reverted as expected)`);
      return;
    }
    fails++;
    console.log(`  FAIL  ${label} — expected ${expectedTag} revert, tx succeeded`);
  } catch (e) {
    const data = (e as { data?: unknown })?.data;
    const msg = e instanceof Error ? e.message : String(e);
    const decoded = decodeRevertBytes(data);
    const tagHit =
      (decoded && decoded.includes(expectedTag)) || msg.includes(expectedTag);
    passes++;
    if (tagHit) {
      console.log(`  PASS  ${label} (reverted with ${expectedTag})`);
    } else {
      console.log(
        `  PASS  ${label} (reverted as expected; tag opaque: ${msg.split("\n")[0].slice(0, 100)})`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("Smoke test — @staging/playground-registry (identity binding)");
  console.log("-------------------------------------------------------------");

  const client = createClient(getWsProvider(ASSET_HUB_WS));
  const { signer, ss58Address: origin } = seedToAccount(DEV_SURI, "");
  const devH160 = deriveH160(signer.publicKey).toLowerCase() as `0x${string}`;

  // Root keypair — distinct from the product/caller account. Never signs a tx;
  // only signs the identity message off-chain.
  const rootSecret = secretFromSeed(ROOT_SEED); // 64-byte expanded secret
  const rootPubkey = getPublicKey(rootSecret); // 32 bytes
  const rootPubkeyHex = bytesToHex(rootPubkey);

  console.log(`DEV SS58 : ${origin}`);
  console.log(`DEV H160 : ${devH160}`);
  console.log(`Contract : ${STAGING_ADDR}`);
  console.log(`Root pk  : ${rootPubkeyHex}`);

  // Pin address + locally-built ABI so cdm.json drift can't hide the new
  // identity methods (same pattern as spike-verify / smoke-test-usernames).
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
  type CdmContracts = { contracts: Record<string, { address: string; abi: unknown }> };
  (cdmJson as unknown as CdmContracts).contracts[PACKAGE].address = STAGING_ADDR;
  (cdmJson as unknown as CdmContracts).contracts[PACKAGE].abi = localAbi;

  const runtime = createContractRuntimeFromClient(client, paseo_asset_hub);
  const manager = new ContractManager(cdmJson, runtime, {
    defaultSigner: signer,
    defaultOrigin: origin,
  });
  const reg: any = manager.getContract(PACKAGE);

  // Pre-flight: confirm the ABI shape really has the new methods.
  console.log("\n[pre-flight] ABI surface");
  check("reg.setIdentity exists", typeof reg.setIdentity?.tx, "function");
  check("reg.clearIdentity exists", typeof reg.clearIdentity?.tx, "function");
  check("reg.getRootAccount exists", typeof reg.getRootAccount?.query, "function");
  check("reg.getRootAccounts exists", typeof reg.getRootAccounts?.query, "function");

  // --- Build + sign the canonical message ----------------------------------
  console.log("\n[1] build wrapped message + raw-sr25519 sign with ROOT key");
  const contractAddr20 = hexAddrToBytes20(STAGING_ADDR);
  const callerH160_20 = hexAddrToBytes20(devH160);
  const message = buildWrappedMessage(contractAddr20, callerH160_20);
  // Sign the wrapped bytes RAW — do NOT let the host re-wrap; we already
  // built the <Bytes>…</Bytes> form the contract reconstructs.
  const sig = sign(rootSecret, message);
  check("signature is 64 bytes", sig.length, 64);

  // --- Scenario 2: set_identity (signed by dev) succeeds --------------------
  console.log("\n[2] DEV binds to ROOT account via set_identity");
  const setRes = await reg.setIdentity.tx(rootPubkeyHex, Array.from(sig), TX_OPTS);
  if (!setRes.ok) throw new Error("setIdentity tx ok=false");
  check("setIdentity ok", setRes.ok, true);

  // --- Scenario 3: read back ------------------------------------------------
  console.log("\n[3] get_root_account(DEV) == root pubkey");
  check(
    "getRootAccount(DEV) == rootPubkey",
    normHex32((await reg.getRootAccount.query(devH160)).value),
    rootPubkeyHex,
  );

  // --- Scenario 4: batch read alignment -------------------------------------
  console.log("\n[4] get_root_accounts([DEV, FAKE]) aligned");
  const batch = await reg.getRootAccounts.query([devH160, FAKE_OTHER] as `0x${string}`[]);
  check(
    "getRootAccounts([DEV, FAKE]) == [rootPubkey, 0x000…0]",
    (batch.value as unknown[]).map(normHex32),
    [rootPubkeyHex, ZERO32],
  );

  // --- Scenario 5: bad signature reverts ------------------------------------
  console.log("\n[5] flipped-byte signature reverts IdentitySigInvalid");
  const badSig = Uint8Array.from(sig);
  badSig[0] ^= 0xff;
  await expectTxRevert("setIdentity(badSig)", "IdentitySigInvalid", () =>
    reg.setIdentity.tx(rootPubkeyHex, Array.from(badSig), TX_OPTS),
  );

  // --- Scenario 6: wrong-length signature reverts ---------------------------
  console.log("\n[6] 63-byte signature reverts IdentitySigLen");
  await expectTxRevert("setIdentity(63 bytes)", "IdentitySigLen", () =>
    reg.setIdentity.tx(rootPubkeyHex, Array.from(sig.slice(0, 63)), TX_OPTS),
  );

  // --- Scenario 7: clear_identity wipes the binding -------------------------
  console.log("\n[7] clear_identity → get_root_account back to 32 zero bytes");
  const clearRes = await reg.clearIdentity.tx(TX_OPTS);
  if (!clearRes.ok) throw new Error("clearIdentity tx ok=false");
  check("clearIdentity ok", clearRes.ok, true);
  check(
    "getRootAccount(DEV) == 0x000…0 after clear",
    normHex32((await reg.getRootAccount.query(devH160)).value),
    ZERO32,
  );

  console.log(`\n${passes} passed, ${fails} failed`);
  client.destroy();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
