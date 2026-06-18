// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
//
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
 * Custom identity migration: v0 "usernames" -> v1 identity bindings.
 *
 * WHY THIS EXISTS
 * ---------------
 * The upstream migrate step calls `registry.importUsernames.tx(...)`, but the
 * v1 registry has NO `importUsernames`. v1 replaced the registry-stored
 * display-name string with an *identity binding*:
 *
 *     account (product H160)  ->  root_pubkey (bytes32 = People AccountId32)
 *
 * set by the user via `setIdentity(root_pubkey, signature)` or by an admin via
 * `adminSetIdentity(account, root_pubkey)`. The human-readable name itself now
 * lives on the People/Individuality chain (`Resources.Consumers` ->
 * full_username / lite_username), NOT in the registry.
 *
 * The v0 snapshot carries only `{ account: H160, name: string }` — it has the
 * display name but NOT the root pubkey, so it cannot feed `adminSetIdentity`
 * directly. The root pubkey must be *recovered* by reverse-resolving the name
 * against the People chain (which is keyed root -> name, so we enumerate it
 * once and invert it in memory).
 *
 * WHAT THIS DOES
 * --------------
 *   1. Enumerate `Resources.Consumers` on Summit People -> reverse index
 *      name (full + lite, case-insensitive) -> [root AccountId32].
 *   2. For each snapshot username, find the unambiguous root for its name.
 *   3. Dry-run by default: print matched / unmatched / ambiguous.
 *      With RUN=1 (+ MNEMONIC): submit `adminSetIdentity(account, root)` for
 *      each unambiguous match, signed by the 5Fk8 admin. Idempotent: skips
 *      accounts whose getRootAccount already equals the target root.
 *
 * USAGE
 *   bun scripts/migrate-identities.ts [snapshot.json]
 * ENV
 *   PEOPLE_WS_URL    People chain WS (default Summit People)
 *   ASSET_HUB_WS_URL Asset Hub WS  (default Summit AH; only used with RUN=1)
 *   MNEMONIC         5Fk8 admin signer (required only with RUN=1)
 *   RUN=1            actually submit adminSetIdentity (default: dry-run)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { summit_individuality } from "@parity/product-sdk-descriptors/summit-individuality";
import {
  ContractManager,
  type CdmJson,
} from "@parity/product-sdk-contracts";
import { seedToAccount } from "@parity/product-sdk-keys";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import cdmJson from "../cdm.json" with { type: "json" };
import { PLAYGROUND_REGISTRY_CONTRACT } from "../src/utils/contractManifest.ts";

const PEOPLE_WS = process.env.PEOPLE_WS_URL ?? "wss://summit-people-rpc.polkadot.io";
const AH_WS = process.env.ASSET_HUB_WS_URL ?? "wss://summit-asset-hub-rpc.polkadot.io";
const RUN = process.env.RUN === "1";
const ZERO_ROOT = "0x" + "00".repeat(32);

type UsernameEntry = { account: string; name: string };

const snapshotPath = resolve(
  process.cwd(),
  process.argv[2] ?? "migration/seed-snapshot.json",
);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const usernames: UsernameEntry[] = snapshot.usernames ?? [];
console.log(`Snapshot      : ${snapshotPath}`);
console.log(`Usernames     : ${usernames.length}`);
if (usernames.length === 0) {
  console.log("Nothing to migrate.");
  process.exit(0);
}

const dec = new TextDecoder();
function decodeName(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length === 0) return null;
  const s = dec.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return s.length > 0 ? s : null;
}
const norm = (s: string) => s.trim().toLowerCase();

// ── 1. Enumerate People Consumers -> reverse index name -> [root] ───────────
console.log(`\nPeople chain  : ${PEOPLE_WS}`);
const people = createClient(getWsProvider(PEOPLE_WS));
const peopleApi = people.getTypedApi(summit_individuality);

console.log("Enumerating Resources.Consumers …");
const entries = await peopleApi.query.Resources.Consumers.getEntries();
console.log(`  consumers on chain: ${entries.length}`);

const nameToRoots = new Map<string, string[]>();
let named = 0;
for (const e of entries) {
  // key arg = root AccountId32 (SS58 string via PAPI codec); value = ConsumerInfo
  const root = Array.isArray(e.keyArgs) ? e.keyArgs[0] : e.keyArgs;
  const info: any = e.value;
  const names = [decodeName(info?.full_username), decodeName(info?.lite_username)].filter(
    (x): x is string => !!x,
  );
  if (names.length) named++;
  for (const n of names) {
    const k = norm(n);
    const arr = nameToRoots.get(k) ?? [];
    if (!arr.includes(String(root))) arr.push(String(root));
    nameToRoots.set(k, arr);
  }
}
console.log(`  consumers with a username: ${named}`);

// AccountId32 SS58 -> 0x32-byte hex (root_pubkey). PAPI surfaces the key as an
// SS58 string; convert via the asset-hub address helper's inverse using PAPI's
// own codec is cleanest, but ss58ToH160 is H160-only. Decode SS58 -> bytes here.
import { AccountId } from "polkadot-api";
const accIdCodec = AccountId();
function ss58ToPubkeyHex(ss58: string): `0x${string}` {
  const bytes = accIdCodec.enc(ss58); // SS58 string -> 32-byte Uint8Array
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

// ── 2. Match each snapshot username to an unambiguous root ───────────────────
type Resolved = { account: string; name: string; root: string; rootHex: `0x${string}` };
const matched: Resolved[] = [];
const unmatched: UsernameEntry[] = [];
const ambiguous: { entry: UsernameEntry; roots: string[] }[] = [];

for (const u of usernames) {
  const roots = nameToRoots.get(norm(u.name)) ?? [];
  if (roots.length === 0) unmatched.push(u);
  else if (roots.length > 1) ambiguous.push({ entry: u, roots });
  else matched.push({ account: u.account, name: u.name, root: roots[0], rootHex: ss58ToPubkeyHex(roots[0]) });
}

console.log(`\n── Resolution ──────────────────────────────────────────────`);
console.log(`matched (unambiguous): ${matched.length}`);
for (const m of matched) console.log(`  ✓ ${m.name.padEnd(22)} ${m.account} -> ${m.root}`);
console.log(`unmatched (no such username on Summit People): ${unmatched.length}`);
for (const u of unmatched) console.log(`  ✗ ${u.name.padEnd(22)} ${u.account}`);
if (ambiguous.length) {
  console.log(`ambiguous (name maps to >1 root — skipped): ${ambiguous.length}`);
  for (const a of ambiguous) console.log(`  ? ${a.entry.name} -> ${a.roots.join(", ")}`);
}

await people.destroy();

if (!RUN) {
  console.log(
    `\nDRY-RUN (set RUN=1 + MNEMONIC to submit adminSetIdentity for the ${matched.length} matched).`,
  );
  process.exit(0);
}
if (matched.length === 0) {
  console.log("\nNo unambiguous matches — nothing to submit.");
  process.exit(0);
}

// ── 3. Submit adminSetIdentity(account, root_pubkey) on v1 (5Fk8 admin) ─────
const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  console.error("::error::RUN=1 requires MNEMONIC (5Fk8 admin signer)");
  process.exit(1);
}
const { signer, ss58Address: origin } = seedToAccount(mnemonic, "");
console.log(`\nAsset Hub     : ${AH_WS}`);
console.log(`Admin signer  : ${origin} (${ss58ToH160(origin)})`);
const ah = createClient(getWsProvider(AH_WS));
const manager = await ContractManager.fromLiveClient(
  cdmJson as unknown as CdmJson,
  ah,
  paseo_asset_hub,
  {
    defaultSigner: signer,
    defaultOrigin: origin,
    registryOrigin: origin,
    libraries: [PLAYGROUND_REGISTRY_CONTRACT],
  },
);
const registry = manager.getContract(PLAYGROUND_REGISTRY_CONTRACT);
console.log(`Registry      : ${manager.getAddress(PLAYGROUND_REGISTRY_CONTRACT)}`);

let done = 0;
let skipped = 0;
for (const m of matched) {
  // m.account is ALREADY an H160 (the v0 snapshot stores product accounts as
  // 0x…20-byte addresses); the contract's address params take it directly.
  const h160 = m.account;
  const cur = await registry.getRootAccount.query(h160);
  if (cur.success && String(cur.value).toLowerCase() === m.rootHex.toLowerCase()) {
    console.log(`  = ${m.name}: already bound, skip`);
    skipped++;
    continue;
  }
  const res = await registry.adminSetIdentity.tx(h160, m.rootHex);
  if (!res.ok) {
    console.error(`::error::adminSetIdentity failed for ${m.name} (${m.account})`);
    continue;
  }
  console.log(`  ✓ ${m.name}: ${m.account} -> ${m.rootHex}  tx=${res.txHash}`);
  done++;
}
console.log(`\nBound ${done} identities (${skipped} already-bound) of ${matched.length} matched.`);
ah.destroy();
process.exit(0);
