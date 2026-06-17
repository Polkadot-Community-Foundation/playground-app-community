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

// Dry-runs Revive.instantiate_with_code against live Paseo Asset Hub to read
// the actual gas_required + storage_deposit for deploying the playground
// registry. No tx submitted, no signer needed.
//
//   pnpm tsx scripts/measure-deploy-cost.ts

import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { seedToAccount } from "@parity/product-sdk-keys";
import { DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { readFileSync } from "node:fs";
import { assetHubWsUrl } from "./_lib.ts";

const REGISTRY_BIN = "target/playground-registry.release.polkavm";
const WS = assetHubWsUrl();

const alice = seedToAccount(DEV_PHRASE, "//Alice");
const origin = alice.ss58Address;

const bytecode = readFileSync(REGISTRY_BIN);
const bytecodeHex = ("0x" + bytecode.toString("hex")) as `0x${string}`;
console.log(`bytecode size: ${bytecode.length} bytes (${(bytecode.length / 1024).toFixed(1)} KB)`);
console.log(`origin (Alice SS58): ${origin}`);
console.log(`endpoint: ${WS}`);

const client = createClient(getWsProvider(WS));
const api = client.getTypedApi(paseo_asset_hub);

try {
    const result = await api.apis.ReviveApi.instantiate(
        origin,
        0n,
        undefined,
        undefined,
        { type: "Upload", value: Binary.fromHex(bytecodeHex) } as any,
        new Uint8Array(0),
        undefined,
    );

    const json = JSON.stringify(
        result,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
    );
    console.log("\n=== ReviveApi.instantiate (dry-run) ===");
    console.log(json);

    const gasRequired = (result as any).gas_required;
    const storageDeposit = (result as any).storage_deposit;
    const r = (result as any).result;

    console.log("\n=== Summary ===");
    if (r?.success === false || r?.value?.flags) {
        console.log("⚠ dry-run reverted — see result above");
    }
    if (gasRequired) {
        console.log(`gas_required.ref_time:   ${gasRequired.ref_time}`);
        console.log(`gas_required.proof_size: ${gasRequired.proof_size}`);
    }
    if (storageDeposit) {
        const planck =
            storageDeposit.type === "Charge"
                ? BigInt(storageDeposit.value)
                : storageDeposit.type === "Refund"
                  ? -BigInt(storageDeposit.value)
                  : 0n;
        const pas = Number(planck) / 1e10; // Paseo Asset Hub uses 10 decimals
        console.log(`storage_deposit.type:  ${storageDeposit.type}`);
        console.log(`storage_deposit.value: ${storageDeposit.value} planck`);
        console.log(`storage_deposit:       ${pas.toFixed(6)} PAS`);
    }
} catch (err) {
    console.error("dry-run failed:", err);
} finally {
    client.destroy();
}
