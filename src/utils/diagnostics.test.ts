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

import { describe, it, expect } from "vitest";
import { stringify } from "./stringify";

// `stringify` is the diagnostic logger's serialiser — used by `runTx`'s
// error/result paths and console.error in `bulletin.ts`. The function exists
// specifically because the Polkadot host's console wrapper renders object
// args as "[object Object]"; we serialise ourselves to a single string. Each
// test below pins down one of the non-obvious behaviours that distinguish
// `stringify` from JSON.stringify (Error walking, bigint handling, Uint8Array
// → hex, circular guard).
describe("stringify", () => {
  it("serialises a plain object as readable JSON", () => {
    const out = stringify({ ok: true, count: 3 });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ ok: true, count: 3 });
  });

  it("walks non-enumerable Error properties (name, message, cause)", () => {
    // JSON.stringify on an Error gives "{}" because Error props are non-
    // enumerable. The function explicitly enumerates getOwnPropertyNames
    // so the message and any custom fields land in the output. Catches the
    // regression where someone "simplifies" stringify back to plain JSON.
    const err = new Error("boom");
    const out = stringify(err);
    expect(out).toContain('"name": "Error"');
    expect(out).toContain('"message": "boom"');
  });

  it("preserves Error custom fields like `cause` and `data`", () => {
    // Substrate revert errors carry .dispatchError / .data. The function
    // must surface them so they're visible in log lines, not silently
    // dropped. Stack is filtered out (too noisy), all other own-property
    // names survive.
    const err = new Error("rejected") as Error & { dispatchError?: string; data?: number };
    err.dispatchError = "ContractReverted";
    err.data = 42;
    const out = stringify(err);
    expect(out).toContain('"dispatchError": "ContractReverted"');
    expect(out).toContain('"data": 42');
  });

  it("omits the stack property from the output", () => {
    // Stacks are too long for log lines; the loop explicitly skips "stack".
    // Asserting absence catches a future regression that re-includes it.
    const err = new Error("with stack");
    const out = stringify(err);
    expect(out).not.toContain('"stack"');
  });

  it("converts bigints to base-10 strings", () => {
    // JSON.stringify on a bigint throws; our replacer converts to string.
    // Tx amounts / chain block numbers are bigint, so this matters
    // everywhere the function is reached.
    const out = stringify({ amount: 1234567890123456789n });
    expect(out).toContain('"amount": "1234567890123456789"');
  });

  it("hex-encodes Uint8Array values as 0x-prefixed strings", () => {
    // Bulletin CIDs / event payloads come through as Uint8Array. The
    // function calls bytesToHex so they end up readable in logs rather
    // than as `{"0":12,"1":255,...}` arrays.
    const bytes = new Uint8Array([0x0c, 0xff, 0x01]);
    const out = stringify({ payload: bytes });
    expect(out).toContain('"payload": "0x0cff01"');
  });

  it("handles circular references without throwing", () => {
    // Module-loaded singletons (signerManager, etc) commonly contain
    // back-references that crash a naive JSON.stringify. The replacer
    // guards via a WeakSet and emits "[Circular]" instead.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const out = stringify(cyclic);
    expect(out).toContain('"self": "[Circular]"');
  });

  it("falls back to a readable error string when JSON.stringify fails outright", () => {
    // The catch branch returns "<stringify failed: ...> <fallback>". An
    // input with a value that *can't* be replaced — a BigInt outside the
    // replacer's reach is now handled, so use a Symbol-valued key (which
    // JSON.stringify silently drops) plus a value that throws via toJSON.
    const explosive = {
      get bad() {
        // `get` accessor that throws when serialised.
        throw new Error("getter exploded");
      },
    };
    const out = stringify(explosive);
    expect(out).toContain("<stringify failed");
  });
});
