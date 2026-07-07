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

/** 32-byte zero AccountId = "no binding / anonymous". */
export const ZERO_ROOT = ("0x" + "00".repeat(32)) as `0x${string}`;

/**
 * Decoded value of `Resources.Consumers` on the People/Individuality chain
 * (paseo_individuality descriptor type `I23bplm6qtgrpd`). The usernames are
 * raw UTF-8 byte arrays, NOT decoded strings: `full_username` is optional
 * (`Uint8Array | undefined`) and `lite_username` is always present but may be
 * empty. We only model the two fields we read; `identifier_key` / `credibility`
 * are ignored here. A wider structural type keeps the resolver unit-testable
 * with a mock and decoupled from the generated descriptor (Task 8 wires the
 * live host-routed client).
 */
type ConsumerInfo = {
  full_username?: Uint8Array | null;
  lite_username?: Uint8Array | null;
};

type IndividualityClient = {
  query: {
    Resources: {
      Consumers: {
        getValues: (keys: [string][]) => Promise<(ConsumerInfo | undefined)[]>;
      };
    };
  };
};

const decoder = new TextDecoder();

/** Decode a username byte array to a non-empty string, or null. */
function decodeName(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length === 0) return null;
  const name = decoder.decode(bytes);
  return name.length > 0 ? name : null;
}

/**
 * Prefer the full DotNS username, else the lite username, else null.
 * Both are raw UTF-8 byte arrays on chain (see `ConsumerInfo`).
 */
function pickName(info: ConsumerInfo | undefined): string | null {
  if (!info) return null;
  return decodeName(info.full_username) ?? decodeName(info.lite_username);
}

/**
 * Resolve a batch of root AccountId32s to People-chain usernames in ONE host
 * storage round-trip. Zero roots are anonymous and never queried. Returns a
 * Map keyed by the input account hex (zero root -> null, bound-but-no-name -> null).
 */
export async function resolveUsernames(
  client: IndividualityClient,
  roots: ReadonlyArray<`0x${string}`>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const bound = roots.filter((r) => r !== ZERO_ROOT);
  for (const r of roots) if (r === ZERO_ROOT) out.set(r, null);
  if (bound.length === 0) return out;
  const values = await client.query.Resources.Consumers.getValues(
    bound.map((r) => [r] as [string]),
  );
  bound.forEach((r, i) => out.set(r, pickName(values[i])));
  return out;
}
