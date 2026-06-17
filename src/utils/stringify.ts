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

import { bytesToHex } from "@parity/product-sdk-utils";

/**
 * Stringify an error/result for logging. The host's console wrapper renders
 * object args as `[object Object]`, so we serialize ourselves and pass a
 * single string. Walks non-enumerable props on Error instances (so message,
 * dispatchError, cause, data etc. all show up) and converts bigints + byte
 * arrays to readable forms.
 *
 * Kept in its own pure module (no Sentry, no telemetry, no contract imports)
 * so node scripts can pull this helper without dragging in the browser-only
 * stack — adding such an import elsewhere in this file silently breaks
 * `scripts/*.ts`.
 */
export function stringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const flatten = (v: unknown): unknown => {
    if (v instanceof Error) {
      const out: Record<string, unknown> = { name: v.name, message: v.message };
      for (const key of Object.getOwnPropertyNames(v)) {
        if (key !== "stack") out[key] = (v as unknown as Record<string, unknown>)[key];
      }
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(value, (_key, val) => {
      val = flatten(val);
      if (typeof val === "bigint") return val.toString();
      if (val instanceof Uint8Array) return "0x" + bytesToHex(val);
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }, 2);
  } catch (e) {
    return `<stringify failed: ${(e as Error).message}> ${String(value)}`;
  }
}
