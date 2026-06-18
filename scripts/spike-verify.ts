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
 * Task 1 spike verification — proves the registry's sr25519Verify precompile
 * calldata encoding works on-chain against the Alice / "hello world" vector.
 *
 *   pnpm tsx scripts/spike-verify.ts
 *
 * Expects: spikeVerify(SIG, utf8("hello world"), PUBKEY) === true
 *          spikeVerify(SIG, utf8("hello worlD"), PUBKEY) === false
 *
 * Deploy @staging first (see CLAUDE.md "Smoke-testing the contract on @staging"),
 * then set STAGING_ADDR below from the new cdm.json entry.
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

const ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_SURI =
  "ensure coffee ripple degree senior grunt unit seek defense year spoon fix";
const PACKAGE = "@staging/playground-registry";
// Update from cdm.json after the @staging deploy.
const STAGING_ADDR = "0x<NEW_STAGING_ADDRESS>";

// Alice / "hello world" sr25519 test vector (raw byte arrays) — copied verbatim
// from polkadot-sdk substrate/frame/revive/src/precompiles/builtin/system.rs.
const SIG = [
  184, 49, 74, 238, 78, 165, 102, 252, 22, 92, 156, 176, 124, 118, 168, 116,
  247, 99, 0, 94, 2, 45, 9, 170, 73, 222, 182, 74, 60, 32, 75, 64, 98, 174, 69,
  55, 83, 85, 180, 98, 208, 75, 231, 57, 205, 62, 4, 105, 26, 136, 172, 17, 123,
  99, 90, 255, 228, 54, 115, 63, 30, 207, 205, 131,
];
const PUBKEY_BYTES = [
  212, 53, 147, 199, 21, 253, 211, 28, 97, 20, 26, 189, 4, 169, 159, 214, 130,
  44, 133, 88, 133, 76, 205, 227, 154, 86, 132, 231, 165, 109, 162, 125,
];
const PUBKEY = ("0x" +
  PUBKEY_BYTES.map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  )) as `0x${string}`;
const MSG_OK = Array.from(new TextEncoder().encode("hello world"));
const MSG_BAD = Array.from(new TextEncoder().encode("hello worlD"));

let passes = 0;
let fails = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}  (got ${JSON.stringify(actual)})`,
  );
  ok ? passes++ : fails++;
}

async function main(): Promise<void> {
  console.log("Spike verify — @staging/playground-registry (sr25519Verify)");
  console.log("-----------------------------------------------------------");

  const client = createClient(getWsProvider(ASSET_HUB_WS));
  const { signer, ss58Address: origin } = seedToAccount(DEV_SURI, "");
  const devH160 = deriveH160(signer.publicKey).toLowerCase() as `0x${string}`;
  console.log(`DEV SS58 : ${origin}`);
  console.log(`DEV H160 : ${devH160}`);
  console.log(`Contract : ${STAGING_ADDR}`);

  // Pin address + locally-built ABI so cdm.json drift can't hide spikeVerify.
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
  (cdmJson as unknown as { contracts: Record<string, { address: string; abi: unknown }> }).contracts[
    PACKAGE
  ].address = STAGING_ADDR;
  (cdmJson as unknown as { contracts: Record<string, { address: string; abi: unknown }> }).contracts[
    PACKAGE
  ].abi = localAbi;

  const runtime = createContractRuntimeFromClient(client, paseo_asset_hub);
  const manager = new ContractManager(cdmJson, runtime, {
    defaultSigner: signer,
    defaultOrigin: origin,
  });
  const reg = manager.getContract(PACKAGE) as unknown as {
    spikeVerify: {
      query: (
        sig: number[],
        msg: number[],
        pk: `0x${string}`,
      ) => Promise<{ value: boolean }>;
    };
  };

  check("reg.spikeVerify exists", typeof reg.spikeVerify?.query, "function");

  const okRes = await reg.spikeVerify.query(SIG, MSG_OK, PUBKEY);
  check('spikeVerify("hello world") === true', okRes.value, true);

  const badRes = await reg.spikeVerify.query(SIG, MSG_BAD, PUBKEY);
  check('spikeVerify("hello worlD") === false', badRes.value, false);

  client.destroy();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
