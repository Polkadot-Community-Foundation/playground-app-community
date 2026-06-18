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

import { registryReady, stringify } from "./utils";
import { withReadDeadline } from "./utils/deadline.ts";
import { ZERO_H160 } from "./utils/username.ts";

export interface RegistryAppData {
  domain: string;
  metadataUri?: string;
  owner?: string;
  visibility: number;
  publisher?: string;
  starCount: number;
  modCount: number;
  hasStarred: boolean;
}

type SolOptionString = string | null | undefined | {
  isSome?: boolean;
  value?: unknown;
};

interface ContractQueryResult {
  success: boolean;
  value: unknown;
}

const normalizeAddress = (raw: unknown): string | undefined => {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).toLowerCase();
  return s === ZERO_H160 ? undefined : s;
};

const optionStringValue = (raw: SolOptionString): string | undefined => {
  if (typeof raw === "string") return raw || undefined;
  if (raw == null || typeof raw !== "object") return undefined;
  if (raw.isSome === false) return undefined;
  return typeof raw.value === "string" && raw.value.length > 0 ? raw.value : undefined;
};

function normalizeAppData(raw: unknown): RegistryAppData | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.domain !== "string" || row.domain.length === 0) return null;

  return {
    domain: row.domain,
    metadataUri: optionStringValue((row.metadata_uri ?? row.metadataUri) as SolOptionString),
    owner: normalizeAddress(row.owner),
    visibility: Number(row.visibility ?? 0),
    publisher: normalizeAddress(row.publisher),
    starCount: Number(row.star_count ?? row.starCount ?? 0),
    modCount: Number(row.mod_count ?? row.modCount ?? 0),
    hasStarred: Boolean(row.has_starred ?? row.hasStarred ?? false),
  };
}

export async function fetchAppDataBatch(
  domains: string[],
  voter?: string | null,
): Promise<Map<string, RegistryAppData> | null> {
  const uniqueDomains = [...new Set(domains.filter((domain) => domain.length > 0))];
  if (uniqueDomains.length === 0) return new Map();

  try {
    const registry = await registryReady;
    const res = await withReadDeadline<ContractQueryResult>(
      (registry as any).getAppData.query(
        uniqueDomains,
        (voter ?? ZERO_H160) as `0x${string}`,
      ),
      "Registry app data",
    );
    if (!res.success) {
      console.warn(
        `[playground] registry.getAppData(${uniqueDomains.length}) returned success:false — ${stringify(res)}`,
      );
      return null;
    }

    const rows = Array.isArray(res.value) ? res.value : [];
    const out = new Map<string, RegistryAppData>();
    for (const raw of rows) {
      const normalized = normalizeAppData(raw);
      if (normalized) out.set(normalized.domain, normalized);
    }
    return out;
  } catch (cause) {
    console.warn(
      `[playground] registry.getAppData(${uniqueDomains.length}) threw — ${stringify(cause)}`,
    );
    return null;
  }
}

export async function fetchAppData(
  domain: string,
  voter?: string | null,
): Promise<RegistryAppData | null> {
  const batch = await fetchAppDataBatch([domain], voter);
  return batch?.get(domain) ?? null;
}
