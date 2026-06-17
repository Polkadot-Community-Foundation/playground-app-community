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

// Confirms every contract address in cdm.json (the deployed registry, the
// system contracts it depends on, and the CDM meta-registry itself) is
// instantiated on the live Asset Hub. Prints each address's account_type so
// stale entries surface as MISSING instead of being silently accepted.
//
//   pnpm tsx scripts/verify-contracts.ts

import { createClient, type HexString } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import cdmJson from "../cdm.json" with { type: "json" };
import { assetHubWsUrl } from "./_lib.ts";

const cdm = cdmJson as unknown as {
  registry?: HexString;
  contracts: Record<string, { address: HexString }>;
};

const targets: { label: string; address: HexString }[] = [
  ...Object.entries(cdm.contracts).map(([label, { address }]) => ({ label, address })),
];
if (cdm.registry) targets.push({ label: "CDM meta-registry", address: cdm.registry });

const labelWidth = Math.max(...targets.map((t) => t.label.length));

const client = createClient(getWsProvider(assetHubWsUrl()));
const api = client.getTypedApi(paseo_asset_hub);

try {
  const infos = await Promise.all(
    targets.map((t) => api.query.Revive.AccountInfoOf.getValue(t.address)),
  );
  for (let i = 0; i < targets.length; i++) {
    const { label, address } = targets[i];
    const info = infos[i];
    const pad = label.padEnd(labelWidth);
    if (!info) {
      console.log(`${pad}  ${address}  MISSING`);
      continue;
    }
    const detail = JSON.stringify(info.account_type, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    console.log(`${pad}  ${address}  EXISTS  ${detail}`);
  }
} finally {
  client.destroy();
}
